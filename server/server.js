const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Generic function to execute commands with timeout and stdin support
function execSpawn(cmd, args, opts = {}, stdinData = null, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try {
          child.kill();
        } catch (e) {
          console.error('Error killing process:', e);
        }
        reject(new Error('Execution timeout'));
      }
    }, timeout);

    if (stdinData && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }

    if (child.stdout) child.stdout.on('data', d => stdout += d.toString());
    if (child.stderr) child.stderr.on('data', d => stderr += d.toString());

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const app = express();
app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: '300kb' }));

// Docker-backed executor for secure sandboxed runs
const { runSubmission, isSupportedLanguage } = require('./executor');

// Add CSP and cross-origin headers
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "script-src 'self' 'unsafe-inline';");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

// Java execution function
async function runJava(code, tests) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-run-'));
  try {
 
    const classNameMatch = code.match(/public\s+class\s+(\w+)/);
    if (!classNameMatch) {
      throw new Error('Invalid Java code: No public class found');
    }
    const className = classNameMatch[1];

    const javaFile = path.join(tmpRoot, `${className}.java`);
    fs.writeFileSync(javaFile, code, 'utf8');

    const compileResult = await execSpawn('javac', [javaFile], { cwd: tmpRoot }, null, 15000);
    if (compileResult.code !== 0) {
      return [{ passed: false, output: null, expected: null, error: compileResult.stderr }];
    }

    const results = [];
    for (const test of tests) {
      const stdinData = test.stdin || '';
      const runResult = await execSpawn('java', [className], { cwd: tmpRoot }, stdinData, 10000);

      if (runResult.code !== 0) {
        results.push({
          passed: false,
          output: null,
          expected: test.expected,
          error: runResult.stderr
        });
      } else {
        const output = runResult.stdout.trim();
        results.push({
          passed: output === test.expected,
          output,
          expected: test.expected,
          error: null
        });
      }
    }

    return results;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}


async function runC(code, tests) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c-run-'));
  try {
    const cFile = path.join(tmpRoot, 'solution.c');
    fs.writeFileSync(cFile, code, 'utf8');

    const compileResult = await execSpawn('gcc', ['-o', 'solution', cFile], { cwd: tmpRoot }, null, 15000);
    if (compileResult.code !== 0) {
      return [{ passed: false, output: null, expected: null, error: compileResult.stderr }];
    }

    const results = [];
    for (const test of tests) {
      const stdinData = test.stdin || '';
      const runResult = await execSpawn('./solution', [], { cwd: tmpRoot }, stdinData, 10000);

      if (runResult.code !== 0) {
        results.push({
          passed: false,
          output: null,
          expected: test.expected,
          error: runResult.stderr
        });
      } else {
        const output = runResult.stdout.trim();
        results.push({
          passed: output === test.expected,
          output,
          expected: test.expected,
          error: null
        });
      }
    }

    return results;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// C++ execution function
async function runCpp(code, tests) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-run-'));
  try {
    const cppFile = path.join(tmpRoot, 'solution.cpp');
    fs.writeFileSync(cppFile, code, 'utf8');

    // Compile C++ code
    const compileResult = await execSpawn('g++', ['-o', 'solution', cppFile], { cwd: tmpRoot }, null, 15000);
    if (compileResult.code !== 0) {
      return [{ passed: false, output: null, expected: null, error: compileResult.stderr }];
    }

    const results = [];
    for (const test of tests) {
      const stdinData = test.stdin || '';
      const runResult = await execSpawn('./solution', [], { cwd: tmpRoot }, stdinData, 10000);

      if (runResult.code !== 0) {
        results.push({
          passed: false,
          output: null,
          expected: test.expected,
          error: runResult.stderr
        });
      } else {
        const output = runResult.stdout.trim();
        results.push({
          passed: output === test.expected,
          output,
          expected: test.expected,
          error: null
        });
      }
    }

    return results;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// Add Python execution logic
async function runPython(code, tests) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'python-run-'));
  try {
    const pythonFile = path.join(tmpRoot, 'solution.py');
    fs.writeFileSync(pythonFile, code, 'utf8');

    const results = [];
    for (const test of tests) {
      const stdinData = test.stdin || '';
      const runResult = await execSpawn('python3', [pythonFile], { cwd: tmpRoot }, stdinData, 10000);

      if (runResult.code !== 0) {
        results.push({
          passed: false,
          output: null,
          expected: test.expected,
          error: runResult.stderr
        });
      } else {
        const output = runResult.stdout.trim();
        results.push({
          passed: output === test.expected,
          output,
          expected: test.expected,
          error: null
        });
      }
    }

    return results;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// Helper to wrap user-provided function-only code into a complete program
function wrapUserCodeForRunner(language, userCode, funcName) {
  const fn = funcName || 'solve';
  const lang = (language || '').toLowerCase();
  switch (lang) {
    case 'python': {
      return userCode + "\n\nif __name__ == '__main__':\n    import sys\n    data = sys.stdin.read()\n    try:\n        res = " + fn + "(data)\n    except TypeError:\n        try:\n            res = " + fn + "()\n        except Exception:\n            res = None\n    if res is not None:\n        print(res)\n";
    }
    case 'javascript':
    case 'js': {
      return userCode + "\n\nif (require.main === module) {\n  const fs = require('fs');\n  const data = fs.readFileSync(0, 'utf8');\n  try {\n    const out = (typeof " + fn + " === 'function') ? " + fn + "(data) : undefined;\n    if (out !== undefined && out !== null) console.log(out);\n  } catch (e) {}\n}\n";
    }
    case 'java': {
      // Place user code inside Main class and call static funcName(String)
      const indented = userCode.split('\n').map(l => '  ' + l).join('\n');
      return 'public class Main {\n' + indented + '\n\n  public static void main(String[] args) throws Exception {\n    java.util.Scanner s = new java.util.Scanner(System.in);\n    StringBuilder sb = new StringBuilder();\n    while (s.hasNextLine()) { sb.append(s.nextLine()); if (s.hasNextLine()) sb.append("\\n"); }\n    String res = null;\n    try { res = ' + fn + '(sb.toString()); } catch (NoSuchMethodError e) { try { ' + fn + '(); } catch (Exception ex) {} }\n    if (res != null) System.out.println(res);\n  }\n}\n';
    }
    case 'c':
    case 'cpp':
    case 'c++': {
      // Assume user provides a function `void funcName()` or `int funcName()` that performs IO
      return userCode + '\n\nint main() {\n    ' + fn + '();\n    return 0;\n}\n';
    }
    default:
      return userCode;
  }
}

// Main execution endpoint
app.post('/api/run', async (req, res) => {
  try {
    const { language, code, tests } = req.body;

    if (!code || !Array.isArray(tests)) {
      return res.status(400).json({ error: 'Missing required fields: code or tests' });
    }

    if (!language) {
      return res.status(400).json({ error: 'Language not specified' });
    }

    // Prepare tests: normalize to { stdin, expected }
    const preparedTests = (tests || []).map(t => {
      if (t.stdin !== undefined) return { stdin: t.stdin, expected: t.expected };
      if (t.input !== undefined) return { stdin: t.input, expected: t.expected };
      if (t.args !== undefined) return { stdin: JSON.stringify(t.args), expected: t.expected };
      return { stdin: '', expected: t.expected };
    });

    const wrappedCode = wrapUserCodeForRunner(language, code, req.body.funcName);

    let results;
    switch (language.toLowerCase()) {
      case 'python':
        results = await runPython(wrappedCode, preparedTests);
        break;
      case 'java':
        results = await runJava(wrappedCode, preparedTests);
        break;
      case 'c':
        results = await runC(wrappedCode, preparedTests);
        break;
      case 'cpp':
      case 'c++':
        results = await runCpp(wrappedCode, preparedTests);
        break;
      default:
        return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    return res.json({ results });
  } catch (e) {
    console.error('Execution error:', e);
    res.status(500).json({ error: String(e) });
  }
});


const db = require('./database');

// Save a submission to the database.
app.post('/api/submit', (req, res) => {
  const { participantName, problemId, language, score } = req.body;

  if (
    typeof participantName !== 'string' ||
    !participantName.trim() ||
    participantName.trim().length > 50
  ) {
    return res.status(400).json({
      error: 'A participant name of 1–50 characters is required.'
    });
  }

  if (
    (typeof problemId !== 'string' && typeof problemId !== 'number') ||
    String(problemId).trim() === ''
  ) {
    return res.status(400).json({ error: 'A valid problemId is required.' });
  }

  if (typeof language !== 'string' || !language.trim()) {
    return res.status(400).json({ error: 'A language is required.' });
  }

  if (!Number.isInteger(score) || score < 0 || score > 100) {
    return res.status(400).json({
      error: 'Score must be an integer between 0 and 100.'
    });
  }

  db.run(
    `INSERT INTO submissions
      (participant_name, problem_id, language, score)
     VALUES (?, ?, ?, ?)`,
    [
      participantName.trim(),
      String(problemId),
      language.trim(),
      score
    ],
    function (error) {
      if (error) {
        console.error('Failed to save submission:', error);
        return res.status(500).json({ error: 'Could not save submission.' });
      }

      return res.status(201).json({
        ok: true,
        id: this.lastID,
        message: 'Submission saved successfully.'
      });
    }
  );
});

// Retrieve rankings using each participant's best score per problem.
app.get('/api/leaderboard', (req, res) => {
  const query = `
    WITH best_scores AS (
      SELECT participant_name, problem_id, MAX(score) AS best_score
      FROM submissions
      GROUP BY participant_name, problem_id
    )
    SELECT
      participant_name AS participantName,
      SUM(best_score) AS totalScore,
      COUNT(*) AS problemsAttempted,
      (
        SELECT COUNT(*)
        FROM submissions AS s
        WHERE s.participant_name = best_scores.participant_name
      ) AS submissionCount
    FROM best_scores
    GROUP BY participant_name
    ORDER BY totalScore DESC, problemsAttempted DESC, participant_name ASC
  `;

  db.all(query, [], (error, rows) => {
    if (error) {
      console.error('Failed to retrieve leaderboard:', error);
      return res.status(500).json({ error: 'Could not load leaderboard.' });
    }

    return res.json({
      leaderboard: rows.map((row, index) => ({
        rank: index + 1,
        ...row
      }))
    });
  });
});

// Optional Docker-backed secure execution endpoint
app.post('/execute', async (req, res) => {
  try {
    const { language, code, tests, funcName, timeLimitMs, memoryLimitMb, outputLimitBytes } = req.body;
    if (!language || !code || !Array.isArray(tests)) return res.status(400).json({ error: 'language, code and tests required' });
    if (!isSupportedLanguage(language)) return res.status(400).json({ error: `Unsupported language: ${language}` });

    const results = await runSubmission({ language, code, tests, timeLimitMs: timeLimitMs || 1000, memoryLimitMb: memoryLimitMb || 256, outputLimitBytes: outputLimitBytes || 65536, funcName });
    return res.json({ results });
  } catch (e) {
    console.error('Docker execution error:', e);
    return res.status(500).json({ error: String(e) });
  }
});

// Serve frontend build if present. Support multiple build locations and env override.
const candidateBuildPaths = [];
if (process.env.BUILD_DIR) candidateBuildPaths.push(process.env.BUILD_DIR);
candidateBuildPaths.push(path.join(__dirname, '..', 'build'));
candidateBuildPaths.push(path.join(__dirname, 'build'));

let resolvedBuildPath = null;
for (const pth of candidateBuildPaths) {
  if (pth && fs.existsSync(pth)) {
    resolvedBuildPath = pth;
    break;
  }
}

if (resolvedBuildPath) {
  app.use(express.static(resolvedBuildPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(resolvedBuildPath, 'index.html'));
  });
}

if (require.main === module) {
  const port = process.env.PORT || 3001;
  const server = app.listen(port, () => console.log(`Multi-language code execution server listening on port ${port}`));

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is in use. Please kill the other process or set PORT environment variable.`);
      process.exit(1);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
}

module.exports = app;
