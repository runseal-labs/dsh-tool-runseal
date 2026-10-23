/** Resolve child argv using the execution environment, never a shell. */
const { access, stat } = require('node:fs/promises');
const { constants } = require('node:fs');
const { delimiter, extname, isAbsolute, resolve } = require('node:path');
exports.resolveExecutable = async function (command, env, cwd, signal) {
    signal?.throwIfAborted();
    if (!command || command.includes('\0'))
        throw new TypeError('runseal: invalid executable');
    const get = key => Object.entries(env).find(([name]) => process.platform === 'win32' ? name.toLowerCase() === key.toLowerCase() : name === key)?.[1];
    const extensions = process.platform === 'win32' && !extname(command) ? (get('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
    const searchPath = get('PATH');
    const paths = isAbsolute(command) || /[/\\]/.test(command)
        ? [resolve(cwd, command)]
        : (searchPath === undefined ? [] : searchPath.split(delimiter)).flatMap(dir => extensions.map(extension => resolve(cwd, process.platform === 'win32' ? dir.trim().replace(/^"|"$/g, '') : dir, command + extension)));
    for (const path of paths) {
        signal?.throwIfAborted();
        try {
            if (!(await stat(path)).isFile())
                continue;
            await access(path, constants.X_OK);
            signal?.throwIfAborted();
            // Preserve executable aliases (for example a virtualenv's Python).
            return path;
        }
        catch {
            signal?.throwIfAborted();
        }
    }
    const error = new Error(`runseal: executable not found: ${command}`);
    error.code = 'ENOENT';
    throw error;
};
