const WebSocket = require("ws");
const axios = require('axios'); // For Google Maps API calls

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_ENDPOINT = process.env.OPENAI_API_ENDPOINT;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const VOICE = "alloy";

const SYSTEM_MESSAGE =
  "You are a calm, professional, and reassuring police emergency call handler. Your primary goal is to quickly and accurately gather critical information from the caller. " +
  "First, greet the user with '911, what is your emergency?'. " +
  "Then, obtain the following information in order: the caller's full name, the exact location of the emergency, and a clear description of the problem. " +
  "When the user provides a location, you MUST use the `find_location` tool to verify it. " +
  "If the `find_location` tool returns multiple possible locations, you must list them to the user and ask for clarification. For example: 'I've found a few possible locations. Are you at [Location A], [Location B], or [Location C]?' " +
  "If the tool returns a single, confirmed location, state it back to the user, for example: 'Okay, I have your location as [Confirmed Location].' and then immediately ask for a description of the problem. " +
  "If the tool returns no locations, inform the user you're having trouble and ask them to spell the street name or provide cross-streets. " +
  "Once you have the name, a confirmed location, and the problem description, reassure the caller that help has been dispatched to their location and to stay on the line if it is safe. Do not invent information.";

const TOOLS = [
  {
    type: "function",
    name: "find_location",
    description: "Finds and verifies a geographic location based on a user's spoken description. Use this as soon as the user provides a potential address or location.",
    parameters: {
      type: "object",
      properties: {
        location_query: {
          type: "string",
          description: "The location mentioned by the user, such as '123 Main Street', 'the corner of Oak and Elm', or 'City Hall'."
        },
      },
      required: ["location_query"],
    },
  },
];


const LOG_EVENT_TYPES = [
  "error",
  "response.done",
  "rate_limits.updated",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "message",
  "response.audio.delta",
];

function handleMediaStream(twilioWs) {
  console.log("Client connected to media stream for emergency services.");

  const openaiWs = new WebSocket(OPENAI_API_ENDPOINT, {
    headers: { "api-key": OPENAI_API_KEY },
  });

  let streamSid = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem = null;
  let markQueue = [];
  let responseStartTimestampTwilio = null;
  let conversationLog = [];
  let incidentReport = {
    callerName: null,
    locationQuery: null,
    locationResults: [],
    confirmedLocation: null,
    problemDescription: null,
  };


  openaiWs.on("open", () => {
    console.log("Connected to OpenAI WebSocket");
    initializeSession(openaiWs);
  });

  twilioWs.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      if (data.event === "media") {
        latestMediaTimestamp = parseInt(data.media.timestamp, 10);
        const audioAppend = {
          type: "input_audio_buffer.append",
          audio: data.media.payload,
        };
        openaiWs.send(JSON.stringify(audioAppend));
      } else if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log(`Incoming stream has started ${streamSid}`);
        responseStartTimestampTwilio = null;
        latestMediaTimestamp = 0;
        lastAssistantItem = null;
        incidentReport = { callerName: null, locationQuery: null, locationResults: [], confirmedLocation: null, problemDescription: null };
      } else if (data.event === "mark") {
        if (markQueue.length > 0) {
          markQueue.shift();
        }
      }
    } catch (error) {
      console.error("Error parsing Twilio message:", error);
    }
  });

  openaiWs.on("message", async (openaiMessage) => {
    try {
      const response = JSON.parse(openaiMessage);

      if (LOG_EVENT_TYPES.includes(response.type) || response.type === "response.function_call_arguments.delta") {
        console.log(`Received event: ${response.type}`, JSON.stringify(response, null, 2));
      }

      if (response.type === "message" && response.role === "user" && response.message?.content?.[0]?.text) {
        const userText = response.message.content[0].text;
        console.log("User (transcribed by AI):", userText);
        conversationLog.push({ type: 'user_utterance', text: userText });

        if (incidentReport.locationResults.length > 1 && !incidentReport.confirmedLocation) {
          incidentReport.locationResults.forEach(loc => {
            if (userText.toLowerCase().includes(loc.split(',')[0].toLowerCase())) {
              incidentReport.confirmedLocation = loc;
              console.log(`Location confirmed by user: ${loc}`);
            }
          });
        }

      } else if (response.type === "message" && response.role === "assistant" && response.message?.content?.[0]?.text) {
        const assistantText = response.message.content[0].text;
        console.log("Assistant (text message):", assistantText);
        conversationLog.push({ type: 'assistant_response', text: assistantText });
      }

      else if (response.type === "response.done" && response.response && response.response.output) {
        const outputs = response.response.output;
        let calledFunctions = false;

        for (const outputItem of outputs) {
          if (outputItem.type === "function_call" && outputItem.name && outputItem.arguments && outputItem.call_id) {
            calledFunctions = true;
            console.log(`Model requests to call function: ${outputItem.name} with call_id: ${outputItem.call_id}`);
            const functionName = outputItem.name;
            const functionArgs = JSON.parse(outputItem.arguments);
            const toolCallId = outputItem.call_id;

            let functionExecutionResultPayload;

            if (functionName === "find_location") {
              const query = functionArgs.location_query;
              console.log(`Executing REAL find_location with query: "${query}"`);
              incidentReport.locationQuery = query;

              let foundLocations = [];

              if (!GOOGLE_MAPS_API_KEY) {
                console.error("CRITICAL: GOOGLE_MAPS_API_KEY environment variable is not set.");
                functionExecutionResultPayload = { success: false, error_message: "The location service is currently unavailable due to a server configuration issue." };
              } else {
                try {
                  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_API_KEY}`;
                  const apiResponse = await axios.get(url);

                  if (apiResponse.data && apiResponse.data.status === 'OK') {
                    foundLocations = apiResponse.data.results.map(result => result.formatted_address);
                    console.log(`Google API returned ${foundLocations.length} results.`);
                  } else {
                    console.log(`Google API returned status: ${apiResponse.data.status}. No locations found.`);
                    foundLocations = [];
                  }

                  if (foundLocations.length === 1) {
                    incidentReport.confirmedLocation = foundLocations[0];
                  }

                  functionExecutionResultPayload = {
                    success: true,
                    found_locations: foundLocations,
                    message: `Location search completed.`
                  };

                } catch (error) {
                  console.error("Error calling Google Maps API:", error.message);
                  functionExecutionResultPayload = { success: false, error_message: "There was an error connecting to the location service." };
                  foundLocations = [];
                }
              }

              incidentReport.locationResults = foundLocations;
              conversationLog.push({ type: "location_search", data: { query: query, results: foundLocations } });

            } else {
              console.warn(`Unknown tool function called: ${functionName}`);
              functionExecutionResultPayload = { success: false, error_message: `Unknown function ${functionName}` };
            }

            const toolResultItem = {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: toolCallId,
                output: JSON.stringify(functionExecutionResultPayload),
              },
            };
            console.log("Sending function call output:", JSON.stringify(toolResultItem, null, 2));
            openaiWs.send(JSON.stringify(toolResultItem));
          }
        }

        if (calledFunctions) {
          console.log("Requesting next assistant response after processing function call(s).");
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        }
      }

      else if (response.type === "response.audio.delta" && response.delta) {
        const decoded = Buffer.from(response.delta, "base64");
        const audioPayload = decoded.toString("base64");
        const audioDelta = {
          event: "media",
          streamSid: streamSid,
          media: { payload: audioPayload },
        };
        twilioWs.send(JSON.stringify(audioDelta));
        if (responseStartTimestampTwilio === null) {
          responseStartTimestampTwilio = latestMediaTimestamp;
        }
        if (response.item_id) {
          lastAssistantItem = response.item_id;
        }
        sendMark(twilioWs, streamSid);
      }

      else if (response.type === "input_audio_buffer.speech_started") {
        console.log("Speech started detected by OpenAI VAD.");
        if (lastAssistantItem) {
          console.log(`Interrupting assistant's speech item_id: ${lastAssistantItem}`);
          handleSpeechInterruption(openaiWs, twilioWs, streamSid, latestMediaTimestamp, responseStartTimestampTwilio, lastAssistantItem);
          markQueue = [];
          lastAssistantItem = null;
          responseStartTimestampTwilio = null;
        }
      }

    } catch (error) {
      console.error("Error processing OpenAI message:", error, "\nOriginal message:", openaiMessage.toString());
    }
  });

  // --- MODIFIED: Replaced email logic with console log summary ---
  twilioWs.on("close", () => {
    console.log("Twilio WebSocket disconnected.");

    if (incidentReport.locationQuery) {
      // Generate and log the final incident summary to the console
      console.log("\n\n========================================");
      console.log("---      INCIDENT CALL SUMMARY     ---");
      console.log("========================================");
      console.log(`Call Ended: ${new Date().toISOString()}`);
      console.log(`Caller's Initial Location Query: "${incidentReport.locationQuery}"`);
      console.log(`Confirmed Location: ${incidentReport.confirmedLocation || "Not confirmed during the call."}`);

      // For brevity, we'll just point to the full log for the description.
      // A more advanced implementation could use another AI call to summarize the problem.
      console.log("Problem Description: See full conversation log for details.");
      console.log("----------------------------------------");
      
      console.log("\n--- Full Conversation Log ---");
      console.log(JSON.stringify(conversationLog, null, 2));
      console.log("========================================\n\n");
      
    } else {
      console.log("No incident data was captured to generate a summary. The call may have ended before information was provided.");
    }

    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
      console.log("OpenAI WebSocket closed.");
    }
  });

  openaiWs.on("error", (error) => {
    console.error("OpenAI WebSocket error:", error);
  });
}

// --- Utility Functions (Unchanged) ---

function sendMark(connection, streamSid) {
  if (streamSid && connection.readyState === WebSocket.OPEN) {
    const markEvent = {
      event: "mark",
      streamSid: streamSid,
      mark: { name: "responsePart" },
    };
    connection.send(JSON.stringify(markEvent));
  }
}

function handleSpeechInterruption(openaiWs, twilioWs, streamSid, latestMediaTimestamp, responseStartTimestampTwilio, assistantAudioItemId) {
  console.log("Handling speech interruption.");
  if (assistantAudioItemId && responseStartTimestampTwilio !== null) {
    console.log("Sending 'clear' event to Twilio to stop playback.");
    twilioWs.send(
      JSON.stringify({
        event: "clear",
        streamSid: streamSid,
      })
    );
  } else {
    console.log("No active assistant audio item to interrupt or timing info missing.");
  }
}

function initializeSession(openaiWs) {
  const sessionUpdate = {
    type: "session.update",
    session: {
      turn_detection: { type: "server_vad" },
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      voice: VOICE,
      instructions: SYSTEM_MESSAGE,
      tools: TOOLS,
      tool_choice: "auto",
      modalities: ["text", "audio"],
      temperature: 0.5,
    },
  };
  console.log("Sending session update:", JSON.stringify(sessionUpdate, null, 2));
  openaiWs.send(JSON.stringify(sessionUpdate));
  sendInitialGreetingPrompt(openaiWs);
}

function sendInitialGreetingPrompt(openaiWs) {
  const initialUserInstructionForItem = {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "The user has just called. Greet them as instructed.",
        },
      ],
    },
  };
  console.log("Sending initial instruction item for AI's greeting:", JSON.stringify(initialUserInstructionForItem));
  openaiWs.send(JSON.stringify(initialUserInstructionForItem));
  openaiWs.send(JSON.stringify({ type: "response.create" }));
  console.log("Sent response.create to generate initial greeting audio.");
}


module.exports = { handleMediaStream };