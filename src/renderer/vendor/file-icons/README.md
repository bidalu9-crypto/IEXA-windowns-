# Material Icon Theme assets used by IEXA

Official source: https://github.com/material-extensions/vscode-material-icon-theme

Pinned commit: `ced21b9b5241c1efa502a8c46ec7363a690a7058` (2026-11-07). License: MIT; the unmodified upstream LICENSE is included.

The included SVGs are a selected subset for file/folder identities. Their colors and artwork remain upstream originals. No network request is made when IEXA renders these images. Every original path, exact commit URL, byte count and SHA256 is recorded in source-manifest.json.

Upstream generates open-folder variants during its build. IEXA applies the same generator rule from src/scripts/svg/generateOpenFolderIcons.ts at the pinned commit: replace only the folder element path with the official OPEN_FOLDER_PATH and preserve the icon motive. The original generator is included for attribution and reproducibility. Each generated file records its closed parent SHA256 and generator SHA256 in the manifest.

The renderer never injects these SVGs as HTML: IDEFileIcons returns decorative local img elements with static allowlisted paths.
