// Tests for POST /execute. Docker is replaced by a fake `child_process.spawn`
// that writes the files a judge container would leave in the mounted workspace,
// so the real executor logic runs without needing Docker installed.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const { spawn } = require('child_process');
const request = require('supertest');
const app = require('../server');

// Queue of behaviours for successive `docker run` calls: compile first, then one per test.
let steps;

function fakeContainer(args, step) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();

  const mount = args[args.indexOf('-v') + 1];
  const workspace = mount.slice(0, mount.lastIndexOf(':/workspace'));

  setImmediate(() => {
    if (step.spawnError) return child.emit('error', step.spawnError);
    for (const [file, content] of Object.entries(step.files || {})) {
      fs.writeFileSync(path.join(workspace, file), content);
    }
    child.emit('close', step.code || 0);
  });
  return child;
}

beforeEach(() => {
  steps = [];
  spawn.mockReset();
  spawn.mockImplementation((cmd, args) => fakeContainer(args, steps.shift() || {}));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const submission = (overrides = {}) => ({
  language: 'python',
  code: 'def solve(data):\n    return int(data) * 2\n',
  funcName: 'solve',
  tests: [{ stdin: '21', expected: '42' }],
  ...overrides,
});

const passingRun = (stdout) => ({ files: { 'stdout.txt': stdout, 'exitcode.txt': '0', 'time.txt': '12' } });

describe('POST /execute', () => {
  describe('successful runs', () => {
    it('marks a submission as passed when stdout matches the expected output', async () => {
      steps = [{}, passingRun('42\n')];

      const res = await request(app).post('/execute').send(submission());

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0]).toMatchObject({ passed: true, stdout: '42\n', exitCode: 0, timeMs: 12 });
    });

    it('marks a submission as failed when stdout does not match', async () => {
      steps = [{}, passingRun('41\n')];

      const res = await request(app).post('/execute').send(submission());

      expect(res.status).toBe(200);
      expect(res.body.results[0]).toMatchObject({ passed: false, stdout: '41\n', exitCode: 0 });
    });

    it('reports a result per test case', async () => {
      steps = [{}, passingRun('42'), passingRun('nope')];

      const res = await request(app)
        .post('/execute')
        .send(submission({ tests: [{ stdin: '21', expected: '42' }, { stdin: '5', expected: '10' }] }));

      expect(res.status).toBe(200);
      expect(res.body.results.map((r) => r.passed)).toEqual([true, false]);
    });

    it('accepts language names case-insensitively', async () => {
      steps = [{}, passingRun('42')];

      const res = await request(app).post('/execute').send(submission({ language: 'Python' }));

      expect(res.status).toBe(200);
      expect(res.body.results[0].passed).toBe(true);
    });
  });

  describe('failing runs', () => {
    it('returns the compiler output and skips the run step on a compile error', async () => {
      const compileError = "solution.c:3:5: error: expected ';' before 'return'";
      steps = [{ code: 1, files: { 'compile.stderr': compileError } }];

      const res = await request(app)
        .post('/execute')
        .send(submission({ language: 'c', code: 'void solve() { int x = 1 return; }' }));

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0]).toMatchObject({ passed: false, compileError, exitCode: null });
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('surfaces stderr and the exit code on a runtime error', async () => {
      const traceback = 'Traceback (most recent call last):\nZeroDivisionError: division by zero';
      steps = [{}, { files: { 'stderr.txt': traceback, 'exitcode.txt': '1', 'time.txt': '8' } }];

      const res = await request(app)
        .post('/execute')
        .send(submission({ code: 'def solve(data):\n    return 1 / 0\n' }));

      expect(res.status).toBe(200);
      expect(res.body.results[0]).toMatchObject({ passed: false, stderr: traceback, exitCode: 1 });
    });

    it('falls back to a generic message when a crash produces no stderr', async () => {
      steps = [{}, { files: { 'exitcode.txt': '139' } }];

      const res = await request(app).post('/execute').send(submission());

      expect(res.body.results[0]).toMatchObject({ passed: false, exitCode: 139, stderr: 'Non-zero exit code: 139' });
    });
  });

  describe('request validation', () => {
    it('rejects an empty body', async () => {
      const res = await request(app).post('/execute').send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/required/i);
      expect(spawn).not.toHaveBeenCalled();
    });

    it.each(['language', 'code', 'tests'])('rejects a submission without %s', async (field) => {
      const body = submission();
      delete body[field];

      const res = await request(app).post('/execute').send(body);

      expect(res.status).toBe(400);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects tests that are not an array', async () => {
      const res = await request(app).post('/execute').send(submission({ tests: 'not-an-array' }));

      expect(res.status).toBe(400);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects an unsupported language', async () => {
      const res = await request(app).post('/execute').send(submission({ language: 'cobol' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unsupported language/i);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects a non-string language', async () => {
      const res = await request(app).post('/execute').send(submission({ language: ['python'] }));

      expect(res.status).toBe(400);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON', async () => {
      const res = await request(app)
        .post('/execute')
        .set('Content-Type', 'application/json')
        .send('{"language": "python",');

      expect(res.status).toBe(400);
    });
  });

  describe('infrastructure failures', () => {
    it('returns 500 when Docker cannot be started', async () => {
      steps = [{ spawnError: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) }];

      const res = await request(app).post('/execute').send(submission());

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/ENOENT/);
    });
  });
});
