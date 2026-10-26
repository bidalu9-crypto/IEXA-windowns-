/**
 * Strip a single leading UTF-8 BOM.
 *
 * Windows tooling writes one by default: PowerShell 5.1's
 * `Set-Content -Encoding utf8` always does, and several editors do too.
 * `JSON.parse` treats it as an unexpected token and fails, so a hand-edited
 * settings or manifest file either fell back to a `.bak` (the edit silently
 * disappeared) or threw.
 *
 * Only the first code unit is removed. A U+FEFF that legitimately appears inside
 * a JSON string value is content, not an encoding artefact, and must survive.
 */
export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
