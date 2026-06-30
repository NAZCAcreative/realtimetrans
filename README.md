# LiveSub AI - Real-time System Audio Translation Platform

LiveSub AI captures system audio, transcribes it in real-time, and provides instant translated subtitles using an Electron + Next.js client and a FastAPI backend server.

---

## 1. Project Structure

```txt
livesub-ai/
├─ apps/
│  ├─ desktop/               # Electron main process & Next.js renderer UI
│  │  ├─ electron/           # Electron main process (main.ts, preload.ts)
│  │  └─ renderer/           # Next.js renderer (React pages, components, Zustand store)
├─ services/
│  ├─ api/                   # FastAPI backend server
│  │  ├─ app/
│  │  │  ├─ main.py          # FastAPI application entry & WebSocket route
│  │  │  ├─ pipeline/        # Realtime audio orchestration pipeline
│  │  │  └─ providers/       # Hot-swappable STT/Translation provider adapters
│  │  └─ tests/              # Test suite & websocket benchmarks
├─ docs/                     # Design and architecture specifications
├─ pnpm-workspace.yaml       # Monorepo workspaces config
└─ package.json              # Monorepo dependencies & scripts
```

---

## 2. Getting Started

### Prerequisites
- Node.js (v18+)
- Python (3.12+)
- Global `pnpm` (`npm install -g pnpm`)

### Setup dependencies

1. **Install Frontend Workspace Dependencies**:
   From the root folder, run:
   ```bash
   pnpm install
   ```

2. **Setup Backend Python Virtual Environment**:
   Navigate to the backend folder and create a venv:
   ```bash
   cd services/api
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r pyproject.toml
   ```
   *(Note: Dependencies can be installed directly from `pyproject.toml` since we configured a project specification. You can also run: `pip install fastapi uvicorn websockets pydantic pydantic-settings sqlalchemy numpy`)*

---

## 3. Running the Application

For the complete real-time mock demonstration, you need to run both the FastAPI backend server and the Electron application.

### Step 1: Start the Backend Server
Run the FastAPI application from `services/api`:
```bash
cd services/api
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8012
```
This launches the backend on `http://localhost:8012`.

### Step 2: Start the Desktop App
Open a new terminal window at the root folder and run:
```bash
pnpm dev:desktop
```
This runs the Next.js dev server on port 3000 and launches the Electron application pointing to it.

---

## 4. Testing & Verification

### Running the Python WebSocket test client
You can test the WebSocket endpoint (`/ws/audio`) directly without running the Electron UI:
1. Ensure the backend server is running.
2. From the `services/api` directory:
   ```bash
   .venv\Scripts\python tests/test_websocket.py
   ```
This script will connect to the WebSocket server, send simulated base64 PCM audio data, and output real-time partial/final STT and translated text in the terminal.
