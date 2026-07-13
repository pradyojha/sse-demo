const express = require('express');
const app = express();

app.use(express.static('public')); // serves UI index.html to client or browser, usually the UI microservice

app.get('/events', (req, res) => {
  // 1. Tell the client this is a stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // 2. Push an event every 2 seconds
  let counter = 0;
  const interval = setInterval(() => {
    counter++;
    const payload = { time: new Date().toISOString(), counter };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }, 2000);

  // 3. Send a comment line every 20s as a heartbeat (prevents proxies/LBs from
  //    thinking the connection is idle and closing it)
  const heartbeat = setInterval(() => res.write(':\n\n'), 20000);

  // 4. Clean up when client disconnects
  req.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
});

//This is the same server for serving UI to the browser and acting as server which pushes the SSE to client
if (require.main === module) {
  app.listen(3000, () => console.log('Server running on http://localhost:3000'));
}

module.exports = app;
