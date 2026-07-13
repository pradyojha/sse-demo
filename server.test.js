const http = require('http');
const request = require('supertest');
const app = require('./server');

describe('static file serving', () => {
  test('GET / serves index.html', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('EventSource');
  });

  test('GET /missing returns 404', async () => {
    const res = await request(app).get('/missing');
    expect(res.status).toBe(404);
  });
});

describe('GET /events (SSE)', () => {
  let server;
  let port;

  beforeAll((done) => {
    server = app.listen(0, () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  test('responds with SSE headers', (done) => {
    const req = http.get(`http://localhost:${port}/events`, (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['connection']).toBe('keep-alive');
      req.destroy();
      done();
    });
  });

  test('streams a data event with the expected payload shape', (done) => {
    const req = http.get(`http://localhost:${port}/events`, (res) => {
      res.on('data', (chunk) => {
        const match = chunk.toString().match(/^data: (.+)\n\n/);
        if (!match) return;

        const payload = JSON.parse(match[1]);
        expect(payload.counter).toBe(1);
        expect(typeof payload.time).toBe('string');
        expect(new Date(payload.time).toISOString()).toBe(payload.time);

        req.destroy();
        done();
      });
    });
  }, 8000);
});
