// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { handleIncomingCall } = require('./twilioHandler');
const { handleMediaStream } = require('./websocketHandler');

const PORT = process.env.PORT || 5050;

// Create Express app
const app = express();

// For Twilio, parse URL-encoded bodies
app.use(express.urlencoded({ extended: true }));

// Health-check route
app.get('/', (req, res) => {
  res.json({ message: "Application is running!" });
});


// Endpoint for handling incoming calls (Twilio will call this URL)
app.all('/incoming-call', handleIncomingCall);

// Create HTTP server so we can use WebSocket upgrades
const server = http.createServer(app);

// Create WebSocket server for /media-stream
const wss = new WebSocket.Server({ noServer: true });

// Handle HTTP upgrade requests for /media-stream
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/media-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// When a new WebSocket connection is established, hand it off to the media stream handler.
wss.on('connection', (ws, request) => {
  console.log("New WebSocket connection on /media-stream");
  handleMediaStream(ws);
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
