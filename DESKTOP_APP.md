# CinchPOS Desktop App

The desktop wrapper lives in `frontend/electron/main.cjs`.

The packaged desktop app includes the Next.js frontend, the Flask API source,
the SQLite database, and a bundled `cinchpos-backend` executable. During
development it can still fall back to `python3 app.py`.

The desktop app icon is generated from `frontend/build/icon.png` into
`frontend/build/icon.icns` and `frontend/build/icon.ico`.

For Windows packages, the build now bundles the official embeddable Python
runtime together with the Flask dependencies, so the Windows app does not need
Python preinstalled on the target machine.

## Run As A Desktop Window

From `frontend`:

```bash
npm run desktop
```

This builds the Next.js frontend, starts the Flask backend on `127.0.0.1:5001`, starts the frontend on `127.0.0.1:3000`, and opens CinchPOS in an Electron desktop window.

For a faster launch after a build already exists:

```bash
npm run desktop:open
```

## Built macOS App

The packaged app bundle is here:

```text
frontend/dist/mac-arm64/CinchPOS.app
```

The drag-and-drop DMG installer is here:

```text
frontend/dist/CinchPOS-1.0.0-arm64.dmg
```

The macOS package installer is here:

```text
frontend/dist/CinchPOS-1.0.0-arm64.pkg
```

The zipped app archive is here:

```text
frontend/dist/CinchPOS-1.0.0-arm64-mac.zip
```

## Rebuild The macOS App

From `frontend`:

```bash
npm run desktop:dist
```

To explicitly build every local macOS package type:

```bash
npm run desktop:dist:mac
```

Both packaging commands rebuild the bundled Flask backend executable first. If
you only want to rebuild the backend binary, run:

```bash
npm run backend:bundle
```

The backend remains Flask and the database remains SQLite. The desktop app only wraps the existing app in a native window and starts the local services.

## Windows Packaging

The same Electron codebase is prepared for Windows packaging as well. Build the
Windows installer set from `frontend` with:

```bash
npm run desktop:dist:win
```

That produces Windows desktop artifacts such as:

- NSIS installer
- portable executable
- zip archive

The default Windows packaging command targets `x64`, which is the practical
default for most Windows PCs.

Current Windows output files:

```text
frontend/dist/CinchPOS Setup 1.0.0.exe
frontend/dist/CinchPOS 1.0.0.exe
frontend/dist/CinchPOS-1.0.0-win.zip
```

The build command downloads the official Windows embeddable Python runtime and
copies the Flask dependencies into it. Before running the Windows packaging
command, make sure the backend virtual environment exists locally so those
dependencies can be copied in:

```bash
cd ../backend
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt pyinstaller
```

From a macOS host, you can now build both operating systems in sequence with:

```bash
npm run desktop:dist:all
```

On a Windows host, use `.venv\Scripts\python` instead of `.venv/bin/python`.

## Linux Packaging

Build the Linux desktop package set from `frontend` with:

```bash
npm run desktop:dist:linux
```

Current Linux output files:

```text
frontend/dist/CinchPOS-1.0.0.AppImage
frontend/dist/cinchpos-frontend-1.0.0.zip
```

The Linux package uses the vendored Flask dependencies inside the app bundle and
launches the backend through `python3` on the target Linux machine.

## Distribution Notes

These packages are ready for local installation and testing on Apple Silicon Macs.
Before public release, add a production app icon and sign/notarize the app with an
Apple Developer ID so macOS Gatekeeper does not warn customers.
