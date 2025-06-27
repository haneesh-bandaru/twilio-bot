// twilioHandler.js
const { VoiceResponse } = require('twilio').twiml;

/**
 * Handle incoming call requests from Twilio.
 * Returns TwiML that instructs Twilio to:
 * - Speak a greeting.
 * - Connect the call to a WebSocket media stream.
 */
function handleIncomingCall(req, res) {
  const twiml = new VoiceResponse();
  // Add messages and pause for a more natural flow
  twiml.say("Please wait while we connect your call to Virtual assistant");
  twiml.pause({ length: 1 });
  twiml.say("O.K. you can start talking!");
  console.log("Please wait while we connect your call to Virtual assistant");
  
  // Connect to the WebSocket media stream endpoint
  const connect = twiml.connect();
  console.log("req.hostname ----> ", req.hostname);
  connect.stream({ url: `wss://${req.hostname}/media-stream` });
  
  res.type('text/xml');
  res.send(twiml.toString());
}

module.exports = { handleIncomingCall };
