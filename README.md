# coding-platform

## About this project

coding-platform is an immersive, assessment-first coding environment built for learning, interviews, and secure timed evaluations. It blends a friendly editor experience with strict integrity controls so instructors and contest hosts can focus on evaluating skill — not chasing down accidental shortcuts.

Key ideas:
- Immersive assessments: during exam or contest mode the UI is intentionally locked down — copying and pasting is restricted, right-click/context menus and developer tools are disabled, and focus is maintained to discourage tab-switching and external lookups.
- Fairness by design: the platform records audit logs and enforces resource limits and per-job isolation so every submission runs in the same, reproducible environment.
- Fast feedback: testcases run inside lightweight language sandboxes and return rich structured results . so learners see useful, actionable feedback immediately.
- Multi-language and function-first: supports Python, Java, Node.js, C and C++ and includes helpers to accept function-only submissions and wrap them safely for execution.

This project aims to be practical for instructors and delightful for learners — combining robust sandboxing with a clean, distraction-minimizing UX.

## Quick start (local development)

### Prerequisites

- **Git**
- **Node.js and npm** (tested with Node.js v24.12.0, npm 11.6.2)
- **Docker**, installed and **running**. The backend runs submitted code inside Docker containers, so code execution fails without it.
  - On Windows, install [Docker Desktop](https://www.docker.com/products/docker-desktop/) with the WSL 2 backend (`wsl --install` in an admin PowerShell, then restart).
  - Check it works with `docker info`.

> **Windows users:** run `git config --global core.autocrlf input` **before cloning**. Otherwise Git converts the shell scripts in `judge/` to CRLF line endings, which breaks them inside the Linux containers (see Troubleshooting).

### 1. Clone the repository

```bash
git clone https://github.com/osl-vvce/coding-platform.git
cd coding-platform
```

### 2. Build the judge images

Run these from the project root. Each language needs its own image; build only the ones you need.

```bash
docker build -t coding-judge-python judge/images/python
docker build -t coding-judge-java   judge/images/java
docker build -t coding-judge-node   judge/images/node
docker build -t coding-judge-c      judge/images/c
docker build -t coding-judge-cpp    judge/images/cpp
```

### 3. Start the backend

```bash
cd server
npm install
npm start
```

The server listens on port **3001** (override with the `PORT` environment variable). Leave this terminal running.

### 4. Start the frontend

In a **second terminal**, from the project root:

```bash
npm install
npm start
```

Open http://localhost:3000.

### 5. Verify it works

Choose **Python**, replace the code with the following, and click **Run Code**:

```python
def solve(data):
    return "hii"
```

You should see `stdout: hii` and `exit code: 0`. Test cases may show "Failed" for placeholder code; that is expected.

### Environment variables

The frontend sends requests to `http://localhost:3001` by default. To point it at a different backend, copy `.env.example` to `.env.local` in the project root:

```bash
REACT_APP_API_BASE_URL=http://localhost:3001
```

Restart `npm start` after changing it.

### Troubleshooting

| Error | Cause | Fix |
| --- | --- | --- |
| "Internal Server Error" in the editor; backend logs `spawn docker ENOENT` | Docker is not installed, not running, or not on your PATH | Install and start Docker Desktop, open a new terminal, and confirm `docker info` works |
| `Unable to find image 'coding-judge-<lang>:latest' locally` | The judge image for the selected language has not been built | Run the matching `docker build -t coding-judge-<lang> judge/images/<lang>` command |
| `/bin/sh: 1: /usr/local/bin/compile: not found` (Windows) | Git converted `judge/` scripts to CRLF line endings | Run `git config core.autocrlf input`, delete and re-checkout the `judge/` folder (`git checkout -- judge`), then rebuild with `docker build --no-cache -t coding-judge-<lang> judge/images/<lang>` |
| `NameError: name 'solve' is not defined` | The platform calls a function named `solve` in your code | Define `def solve(data): ...` |

`npm install` prints many deprecation warnings and `npm audit` findings. These come from old pinned dependencies and are safe to ignore for local development.


## Running the backend tests

The `/execute` API is covered by Jest + Supertest tests in `server/tests/execute.test.js`. Docker is mocked, so you do not need Docker or the judge images to run them.

```bash
cd server
npm install
npm test
```

The suite covers passing and failing submissions, compile errors, runtime errors, an empty body, missing or malformed fields, unsupported languages and Docker being unavailable.

## Developer notes

- Frontend now calls the Docker-backed `/execute` endpoint and shows `compileError`, `stderr`, and non-zero exit statuses prominently.
- `REACT_APP_API_BASE_URL` is used for configuring the API base URL in different environments.

## Tech stack

- Backend: Node.js (Express)
- Frontend: React (Create React App) and CodeMirror for the editor
- Sandboxing: Docker judge images (GCC for C/C++, Temurin JDK for Java, Python 3, Node.js)





