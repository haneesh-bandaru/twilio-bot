// twilioHandler.js
const { VoiceResponse } = require('twilio').twiml;

function handleIncomingCall(req, res) {
  try {
    console.log("Incoming call request received. Generating TwiML...");
    const twiml = new VoiceResponse();

    twiml.say("Please wait while we connect your call to our virtual assistant.");
    twiml.pause({ length: 1 });
    twiml.say("Okay, you can start talking!");

    const connect = twiml.connect();
    const wssUrl = `wss://${req.hostname}/media-stream`;
    console.log(`Attempting to connect to WebSocket at: ${wssUrl}`);
    connect.stream({ url: wssUrl });

    res.type('text/xml');
    res.send(twiml.toString());
    console.log("TwiML response sent successfully.");

  } catch (error) {
    console.error("!!! CRITICAL ERROR IN handleIncomingCall !!!", error);
    res.status(500).send("An internal server error occurred.");
  }
}

module.exports = { handleIncomingCall };