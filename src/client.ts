import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { createElement as h, useState, useSyncExternalStore } from 'react'

export const inject = ['slots', 'configForms']

/** Use dsh's revision-fenced configuration service and profile persistence. */
export function apply(ctx: Context): void {
  const form = ctx.configForms.get<Record<string, unknown>>('sandbox-runseal')
  function Settings() {
    const state = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
    const [draft, setDraft] = useState<Record<string, unknown>>({})
    const [message, setMessage] = useState('')
    const [saving, setSaving] = useState(false)
    const fields = [
      ['command', 'RunSeal 可执行文件（留空使用自动下载版本）', 'text'],
      ['networkMode', '网络模式', 'select'],
      ['timeoutMs', '执行超时（毫秒）', 'number'],
      ['maxStdinBytes', '缓冲输入上限（字节）', 'number'],
      ['autoSetup', '独立 wrapper 自动安装沙箱', 'checkbox'],
      ['args', '额外参数（JSON 数组）', 'args'],
    ] as const
    const disabled = !state.writable || saving
    async function save() {
      setSaving(true)
      setMessage('')
      try {
        const ops = Object.entries(draft).map(([key, value]) => {
          if (key === 'args') {
            value = JSON.parse(String(value)) as unknown
            if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('额外参数必须是字符串数组')
          }
          if ((key === 'timeoutMs' || key === 'maxStdinBytes') && (!Number.isSafeInteger(value) || Number(value) < 1)) throw new Error('数值必须是正整数')
          return { op: 'set' as const, path: [key], value }
        })
        if (await form.mutate(ops, state.revision)) { setDraft({}); setMessage('已保存') }
        else setMessage('保存未完成，请刷新配置后重试')
      } catch (error) { setMessage(String(error)) }
      finally { setSaving(false) }
    }
    if (state.status !== 'ready') return h('p', null, state.status === 'unavailable' ? 'RunSeal 配置不可用，请确认组件已启用。' : '正在读取 RunSeal 配置…')
    return h('form', { onSubmit: event => { event.preventDefault(); void save() }, style: { display: 'grid', gap: '16px', maxWidth: '640px' } },
      h('p', null, '保存后对新命令生效；正在执行的命令继续使用启动时的配置。'),
      ...fields.map(([key, label, type]) => {
        const value = draft[key] ?? (type === 'args' ? JSON.stringify(state.value?.[key] ?? []) : state.value?.[key])
        const change = (value: unknown) => setDraft(previous => ({ ...previous, [key]: value }))
        const control = type === 'select'
          ? h('select', { value: String(value ?? 'unmanaged'), disabled, onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) => change(event.currentTarget.value) }, ...['unmanaged', 'disabled', 'proxy'].map(mode => h('option', { key: mode, value: mode }, mode)))
          : h('input', { type: type === 'args' ? 'text' : type, disabled,
            ...(type === 'checkbox' ? { checked: Boolean(value) } : { value: String(value ?? '') }),
            ...(type === 'number' ? { min: 1, step: 1 } : {}),
            onChange: event => change(type === 'checkbox' ? event.target.checked : type === 'number' ? Number(event.target.value) : event.target.value),
            style: { width: type === 'checkbox' ? undefined : '100%' } })
        return h('label', { key, style: { display: 'grid', gap: '6px' } }, label, control)
      }),
      h('button', { type: 'submit', disabled: disabled || Object.keys(draft).length === 0 }, saving ? '保存中…' : '保存配置'),
      h('p', { role: 'status' }, message))
  }
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-tool-runseal' }, Settings))
}


