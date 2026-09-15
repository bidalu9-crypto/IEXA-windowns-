/**
 * Child executable/config discovery contract (case-insensitive on every OS):
 * PATH/PATHEXT, Windows system/profile folders, HOME/XDG config folders, temp,
 * locale, and explicit Node/Python/Java/virtualenv executable paths are inherited.
 * Arbitrary app/provider variables, proxy URLs, credential values, NODE_OPTIONS,
 * preload hooks and agent sockets are NOT inherited. This is not an OS sandbox:
 * children still have the user's filesystem access, including config files.
 * PluginRunner adds its two fixed Electron/Node flags at the call site.
 */
const INHERITED_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'PYTHON', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONIOENCODING', 'VIRTUAL_ENV',
  'CONDA_PREFIX', 'JAVA_HOME', 'JDK_HOME', 'NVM_HOME', 'NVM_SYMLINK', 'VOLTA_HOME',
]);

export function createChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(source)) {
    const canonical = name.toUpperCase();
    if (typeof value !== 'string' || !INHERITED_NAMES.has(canonical) || seen.has(canonical)) continue;
    result[name] = value;
    seen.add(canonical);
  }
  return result;
}
