# CinchPOS Desktop Project Structure

Active source folders:

- `frontend/` - Next.js static-export frontend and Electron desktop shell
- `backend/` - Flask API and SQLite database

Generated folders that should stay out of Git:

- `frontend/.next`
- `frontend/out`
- `frontend/dist`
- `frontend/node_modules`
- `backend/.venv`
- `backend/dist`
- `backend/__pycache__`

Installer and archive files in the project root are distribution artifacts, not source of truth.

Recommended GitHub push scope:

- `frontend/app`
- `frontend/components`
- `frontend/electron`
- `frontend/lib`
- `frontend/public`
- `frontend/scripts`
- `frontend/tests`
- `frontend/package.json`
- `frontend/package-lock.json`
- `frontend/next.config.mjs`
- `backend/app.py`
- `backend/requirements.txt`
- `backend/tests`
- project documentation files
