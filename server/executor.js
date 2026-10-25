const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function shellSpawn(cmd, args, opts = {}, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    let killed = false;

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch (e) {}
      }, timeoutMs);
    }

    if (child.stdout) child.stdout.on('data', d => stdout += d.toString());
    if (child.stderr) child.stderr.on('data', d => stderr += d.toString());

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

// Map language to pre-built docker image name
const IMAGE_MAP = {
  c: 'coding-judge-c',
  cpp: 'coding-judge-cpp',
  'c++': 'coding-judge-cpp',
  java: 'coding-judge-java',
  python: 'coding-judge-python',
  javascript: 'coding-judge-node',
  js: 'coding-judge-node'
};

function isSupportedLanguage(language) {
  return typeof language === 'string' && Object.prototype.hasOwnProperty.call(IMAGE_MAP, language.toLowerCase());
}

async function runSubmission({ language, code, tests = [], timeLimitMs = 1000, memoryLimitMb = 256, outputLimitBytes = 65536, funcName = null }) {
  if (!language || !code) throw new Error('language and code required');
  const langKey = language.toLowerCase();
  const image = IMAGE_MAP[langKey];
  if (!image) throw new Error('Unsupported language: ' + language);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-'));
  // Ensure workspace exists
  const workspace = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  // Normalize tests: if test has args, serialize as stdin
  const preparedTests = (tests || []).map(t => {
    if (t.stdin !== undefined) return { stdin: t.stdin, expected: t.expected };
    if (t.input !== undefined) return { stdin: t.input, expected: t.expected };
    if (t.args !== undefined) return { stdin: JSON.stringify(t.args), expected: t.expected };
    return { stdin: '', expected: t.expected };
  });

  // Helper to wrap user-provided function-only code into a full program
  function wrapUserCode(language, userCode, funcName) {
    const fn = funcName || 'solve';
    const lang = (language || '').toLowerCase();
    switch (lang) {
      case 'python':
        // Call user function; only handle TypeError for signature mismatch, let other exceptions propagate
        return userCode + "\n\nif __name__ == '__main__':\n    import sys\n    data = sys.stdin.read()\n    try:\n        res = " + fn + "(data)\n    except TypeError:\n        res = " + fn + "()\n    if res is not None:\n        print(res)\n";
      case 'javascript':
      case 'js':
        // Only let signature-related errors be handled; runtime exceptions should surface
        return userCode + "\n\nif (require.main === module) {\n  const fs = require('fs');\n  const data = fs.readFileSync(0, 'utf8');\n  if (typeof " + fn + " === 'function') {\n    // try calling with data, fall back to no-arg if TypeError-like occurs\n    try {\n      const out = " + fn + "(data);\n      if (out !== undefined && out !== null) console.log(out);\n    } catch (e) {\n      // if it's because of wrong arity, try without args, otherwise rethrow\n      try {\n        const out = " + fn + "();\n        if (out !== undefined && out !== null) console.log(out);\n      } catch (e2) {\n        throw e2;\n      }\n    }\n  }\n}\n";
      case 'java': {
        const indented = userCode.split('\n').map(l => '  ' + l).join('\n');
        // Call user's static method; only handle NoSuchMethodError to try no-arg variant,
        // let other exceptions propagate so JVM prints a stacktrace to stderr.
        return 'public class Main {\n' + indented + '\n\n  public static void main(String[] args) throws Exception {\n    java.util.Scanner s = new java.util.Scanner(System.in);\n    StringBuilder sb = new StringBuilder();\n    while (s.hasNextLine()) { sb.append(s.nextLine()); if (s.hasNextLine()) sb.append("\\n"); }\n    String res = null;\n    try {\n      res = ' + fn + '(sb.toString());\n    } catch (NoSuchMethodError e) {\n      // try no-arg version and allow other exceptions to propagate\n      res = ' + fn + '();\n    }\n    if (res != null) System.out.println(res);\n  }\n}\n';
      }
      case 'c':
      case 'cpp':
      case 'c++':
        return userCode + '\n\nint main() {\n    ' + fn + '();\n    return 0;\n}\n';
      default:
        return userCode;
    }
  }

  // Write source file per language
  let sourceFile = 'solution.txt';
  switch (langKey) {
    case 'c': sourceFile = 'solution.c'; break;
    case 'cpp': case 'c++': sourceFile = 'solution.cpp'; break;
    case 'java': sourceFile = 'Main.java'; break;
    case 'python': sourceFile = 'solution.py'; break;
    case 'javascript': case 'js': sourceFile = 'solution.js'; break;
  }
  const wrapped = wrapUserCode(langKey, code, funcName);
  fs.writeFileSync(path.join(workspace, sourceFile), wrapped, 'utf8');

  // Run compilation inside a disposable container (compile step)
  const compileCmd = [
    'run', '--rm',
    '--network', 'none',
    '--user', '1000:1000',
    '--read-only',
    '--tmpfs', '/tmp:rw',
    '-v', `${workspace}:/workspace:rw`,
    image,
    '/usr/local/bin/compile'
  ];

  // Run compile (capture docker exit code and any stdout/stderr)
  const compileResult = await shellSpawn('docker', compileCmd, {}, 60000);

  // Path where compile scripts write compilation errors inside workspace
  const compileErrPath = path.join(workspace, 'compile.stderr');

  // If docker compile process failed (non-zero) or compile.stderr has contents, return compile error
  const compileStdErr = fs.existsSync(compileErrPath) ? fs.readFileSync(compileErrPath, 'utf8') : '';
  if ((compileResult && compileResult.code !== 0) || (compileStdErr && compileStdErr.trim().length > 0)) {
    const compileErr = (compileStdErr && compileStdErr.trim().length > 0) ? compileStdErr : (compileResult.stderr || 'Compilation failed');
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
    return [{
      passed: false,
      stdout: '',
      stderr: compileErr,
      exitCode: null,
      timeMs: null,
      compileError: compileErr
    }];
  }

  const results = [];
  for (let i = 0; i < preparedTests.length; i++) {
    const t = preparedTests[i];
    // write stdin for this test
    const stdinPath = path.join(workspace, 'stdin.txt');
    fs.writeFileSync(stdinPath, (t.stdin || ''), 'utf8');

    const memKb = Math.max(32, memoryLimitMb) * 1024;

    const runArgs = [
      'run', '--rm',
      '--network', 'none',
      '--user', '1000:1000',
      '--read-only',
      '--tmpfs', '/tmp:rw',
      '--memory', `${memoryLimitMb}m`,
      '--pids-limit', '128',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '-v', `${workspace}:/workspace:rw`,
      '-e', `TIME_LIMIT_MS=${timeLimitMs}`,
      '-e', `MEM_LIMIT_KB=${memKb}`,
      '-e', `OUTPUT_LIMIT_BYTES=${outputLimitBytes}`,
      image,
      '/usr/local/bin/run'
    ];

    // Add a reasonable timeout on the docker client side (double the timeLimit)
    const clientTimeoutMs = Math.max(5000, timeLimitMs * 2 + 2000);
    await shellSpawn('docker', runArgs, {}, clientTimeoutMs);

    // Read outputs
    const stdoutPath = path.join(workspace, 'stdout.txt');
    const stderrPath = path.join(workspace, 'stderr.txt');
    const exitPath = path.join(workspace, 'exitcode.txt');
    const timePath = path.join(workspace, 'time.txt');
    const compileErrPath = path.join(workspace, 'compile.stderr');

    const out = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
    let err = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
    const exitcode = fs.existsSync(exitPath) ? parseInt(fs.readFileSync(exitPath, 'utf8')) : null;
    const timeMs = fs.existsSync(timePath) ? parseInt(fs.readFileSync(timePath, 'utf8')) : null;
    const compileErr = fs.existsSync(compileErrPath) ? fs.readFileSync(compileErrPath, 'utf8') : null;

    // If program exited non-zero but produced no stderr, surface the exit code as an error message
    if ((exitcode !== null) && exitcode !== 0 && (!err || String(err).trim().length === 0)) {
      err = `Non-zero exit code: ${exitcode}`;
    }

    results.push({
      passed: (out.trim() === (t.expected || '').trim()),
      stdout: out,
      stderr: err,
      exitCode: exitcode,
      timeMs,
      compileError: compileErr
    });
  }

  // cleanup
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}

  return results;
}

module.exports = { runSubmission, isSupportedLanguage };
