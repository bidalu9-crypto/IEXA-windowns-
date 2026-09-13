'use strict';
function supported(version) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}
if (require.main === module) {
  if (!supported(process.versions.node)) {
    console.error(`Node >=22.13.0 is required; found ${process.versions.node}`);
    process.exitCode = 1;
  }
}
module.exports = { supported };
