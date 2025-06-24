const WebSocket = require("ws");
const { Resend } = require("resend");
const resend = new Resend(process.env.SEND_KEY);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_ENDPOINT = process.env.OPENAI_API_ENDPOINT;
const VOICE = "alloy";

const SYSTEM_MESSAGE =
  "You are a helpful AI assistant. You can help with scheduling medical appointments, booking movie tickets, IT support and Customer order tracking support. " +
  "First, greet the user and ask how you can assist them. Be conversational. " +
  "When you have enough information to use a tool, call the appropriate function. " +
  "For IT support, first collect the user's name, employee ID, and a description of the issue. Then, call the 'log_it_issue_for_troubleshooting' function. " +
  "After the issue is logged by the function, YOU should then provide some general troubleshooting suggestions to the user based on their issue description. " +
  "Ask the user if the suggestions helped. If they say the suggestions did not help or they need more assistance, inform them that you are creating a support ticket and an agent will contact them shortly. " +
  "For Customer order tracking support, first collect customer's name and order ID. Then, call the 'customer_order_tracking' function." +
  "When the user provides an Order ID that matches one in the dummy data, retrieve and state the corresponding details (Status, Estimated Delivery/Delivered Date, Carrier)." +
  `Dummy Order Data:
     1) Order ID: 12345
        Status: Shipped
        Estimated Delivery: < fetch the current date and add 2 days to it (Tell that date) >
        Carrier: FedEx
     2) Order ID: 67890
        Status: Processing
        Estimated Delivery: < fetch the current date and add 2 days to it (Tell that date) >
        Carrier: UPS
     3) Order ID: 11223
        Status: Delivered
        Delivered Date: 2023-10-25
        Carrier: USP` +
    "If the user provides an Order ID that is not in the dummy data, inform them that please provide me the correct orderId." +
  "Do not make up information for parameters not provided by the user; ask for clarification if needed.";

const TOOLS = [
  {
    type: "function",
    name: "schedule_medical_appointment",
    description: "Schedules a medical appointment. Collects doctor name, caller's name, phone number, email, and desired appointment date/time.",
    parameters: {
      type: "object",
      properties: {
        docname: { type: "string", description: "The name of the doctor for the appointment." },
        name: { type: "string", description: "The name of the caller scheduling the appointment." },
        phone: { type: "string", description: "The phone number of the caller." },
        email: { type: "string", description: "The email address of the caller." },
        appointment_datetime: { type: "string", description: "The desired date and time for the appointment (e.g., 'Tomorrow at 3 PM', '2024-07-15 10:00 AM'). Needs to be a specific date and time." },
      },
      required: ["docname", "name", "phone", "email", "appointment_datetime"],
    },
  },
  {
    type: "function",
    name: "book_movie_ticket",
    description: "Books movie tickets. Collects movie name, user's name, number of tickets, and desired show date/time.",
    parameters: {
      type: "object",
      properties: {
        movie_name: { type: "string", description: "The name of the movie to book tickets for." },
        user_name: { type: "string", description: "The name of the person booking the tickets." },
        num_tickets: { type: "integer", description: "The number of tickets to book." },
        show_datetime: { type: "string", description: "The desired date and time for the movie show (e.g., 'Tonight at 7 PM', '2024-07-16 19:30'). Needs to be a specific date and time." },
      },
      required: ["movie_name", "user_name", "num_tickets", "show_datetime"],
    },
  },
  { // New IT Support Tool
    type: "function",
    name: "log_it_issue_for_troubleshooting",
    description: "Logs an IT issue reported by a user. Collects user's name, employee ID, and a description of the problem. After this, the AI should provide troubleshooting steps.",
    parameters: {
      type: "object",
      properties: {
        user_name: { type: "string", description: "The name of the user reporting the IT issue." },
        employee_id: { type: "string", description: "The employee ID of the user." },
        issue_description: { type: "string", description: "A clear description of the IT problem the user is facing." },
      },
      required: ["user_name", "employee_id", "issue_description"],
    },
  },
  {
    type: "function",
    name: "customer_order_tracking",
    description: "Track the customer order details with his order ID. Collects customer name and order ID.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "The name of the customer asking for order tracking." },
        order_id: { type: "string", description: "The order ID of the customer." },
      },
      required: ["customer_name", "order_id"]
    },
  },
];

// Define the dummy order data as a constant object for easy lookup
const dummyOrderData = {
  "12345": { Status: "Shipped", "Estimated Delivery": "2023-10-27", Carrier: "FedEx" },
  "67890": { Status: "Processing", "Estimated Delivery": "2023-10-30", Carrier: "UPS" },
  "11223": { Status: "Delivered", "Delivered Date": "2023-10-25", Carrier: "USP" },
};


const LOG_EVENT_TYPES = [
  "error",
  "response.done", // Key event for function calling detection
  "rate_limits.updated",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "message", // For user transcriptions and assistant direct text (if any)
  "response.audio.delta", // For debugging audio
];


function generateRandomTicketId() {
  return `TICKET-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
}

function handleMediaStream(twilioWs) {
  console.log("Client connected to media stream");

  const openaiWs = new WebSocket(OPENAI_API_ENDPOINT, {
    headers: { "api-key": OPENAI_API_KEY },
  });

  let streamSid = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem = null;
  let markQueue = [];
  let responseStartTimestampTwilio = null;
  let conversationLog = [];
  let currentItIssueDetails = null; // To hold IT issue details temporarily for email
  let itIssueSolved = null; // null, true, or false

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI WebSocket");
    initializeSession(openaiWs);
  });

  twilioWs.on("message", (message) => {
    // ... (Twilio message handling remains the same) ...
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
        currentItIssueDetails = null; // Reset for new call
        itIssueSolved = null; // Reset for new call
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

        // Check if this user utterance is a response to IT troubleshooting
        if (currentItIssueDetails && itIssueSolved === null) { // If an IT issue is active and we're waiting for user feedback
            // Simple keyword check. For more robust solution, use NLU or prompt AI to classify.
            const positiveKeywords = ["yes", "solved", "fixed", "worked", "thank you", "that helped"];
            const negativeKeywords = ["no", "didn't work", "still broken", "not solved", "can't solve", "no can't solve it", "still facing issue"];

            if (positiveKeywords.some(kw => userText.toLowerCase().includes(kw))) {
                itIssueSolved = true;
                console.log("IT Issue marked as SOLVED by user response.");
            } else if (negativeKeywords.some(kw => userText.toLowerCase().includes(kw))) {
                itIssueSolved = false;
                console.log("IT Issue marked as NOT SOLVED by user response. AI should now mention ticket creation.");
                // The AI will now (based on system prompt) say it's creating a ticket.
                // We will capture this in the email.
            }
        }

      } else if (response.type === "message" && response.role === "assistant" && response.message?.content?.[0]?.text) {
        const assistantText = response.message.content[0].text;
        console.log("Assistant (text message):", assistantText);
        conversationLog.push({ type: 'assistant_response', text: assistantText });

        // Check if assistant is mentioning ticket creation
        if (currentItIssueDetails && itIssueSolved === false) {
            if (assistantText.toLowerCase().includes("ticket") && (assistantText.toLowerCase().includes("creating") || assistantText.toLowerCase().includes("created") || assistantText.toLowerCase().includes("raising"))) {
                if (!currentItIssueDetails.ticket_id) { // Assign ticket ID only once
                    currentItIssueDetails.ticket_id = generateRandomTicketId();
                    console.log(`IT Support Ticket ID ${currentItIssueDetails.ticket_id} notionally created for user ${currentItIssueDetails["User Name"]}`);
                }
            }
        }
      }


      // --- Handle Function Calls based on "Realtime models" spec ---
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

            if (functionName === "schedule_medical_appointment") {
              // ... (same as before)
              console.log(`Executing schedule_medical_appointment with args:`, functionArgs);
              const appointmentData = {
                "Doctor Name": functionArgs.docname,
                "Caller Name": functionArgs.name,
                "Phone": functionArgs.phone,
                "Email": functionArgs.email,
                "Appointment Date & Time": functionArgs.appointment_datetime,
              };
              conversationLog.push({ type: "medical_appointment", data: appointmentData });
              functionExecutionResultPayload = { success: true, details: appointmentData, confirmation_message: `Medical appointment for ${functionArgs.name} with ${functionArgs.docname} has been noted.` };
            } else if (functionName === "book_movie_ticket") {
              // ... (same as before)
              console.log(`Executing book_movie_ticket with args:`, functionArgs);
              const movieData = {
                "Movie Name": functionArgs.movie_name,
                "User Name": functionArgs.user_name,
                "Number of Tickets": functionArgs.num_tickets,
                "Show Date & Time": functionArgs.show_datetime,
              };
              conversationLog.push({ type: "movie_booking", data: movieData });
              functionExecutionResultPayload = { success: true, details: movieData, confirmation_message: `${functionArgs.num_tickets} ticket(s) for ${functionArgs.movie_name} noted for ${functionArgs.user_name}.` };
            } else if (functionName === "log_it_issue_for_troubleshooting") { 
              console.log(`Executing log_it_issue_for_troubleshooting with args:`, functionArgs);
              currentItIssueDetails = { // Store for email generation
                "User Name": functionArgs.user_name,
                "Employee ID": functionArgs.employee_id,
                "Issue Description": functionArgs.issue_description,
                // ticket_id will be added later if needed
              };
              itIssueSolved = null; // Reset for this new issue
              conversationLog.push({ type: "it_support_logged", data: { ...currentItIssueDetails } }); // Log initial report
              functionExecutionResultPayload = {
                success: true,
                message: `IT issue for ${functionArgs.user_name} (ID: ${functionArgs.employee_id}) regarding '${functionArgs.issue_description}' has been logged. I will now provide some troubleshooting steps.`,
              };
            } else if (functionName === "customer_order_tracking") {
              console.log(`Executing customer_order_tracking with args:`, functionArgs);
              const customerData = {
                "Customer Name": functionArgs.customer_name,
                "Order ID": functionArgs.order_id,
              };
              conversationLog.push({ type: "order_tracking", data: customerData });
              functionExecutionResultPayload = { success: true, details: customerData, confirmation_message: `The Customer name ${functionArgs.customer_name} with Order ID of ${functionArgs.order_id} for tracking has been noted.` };
            }
            else {
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
        } else {
            console.log("response.done received, no function calls detected in output.");
        }
      }

      // --- Handle Audio Output from OpenAI ---
      else if (response.type === "response.audio.delta" && response.delta) {
        // ... (same as before) ...
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

      // --- Handle Interruptions ---
      else if (response.type === "input_audio_buffer.speech_started") {
        // ... (same as before) ...
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

  twilioWs.on("close", async () => {
    console.log("Twilio WebSocket disconnected.");
    console.log("Final Conversation Log:", JSON.stringify(conversationLog, null, 2));
    // Add currentItIssueDetails to conversationLog if it exists and isn't fully logged
    if (currentItIssueDetails) {
        const existingLog = conversationLog.find(entry =>
            entry.type === 'it_support_logged' &&
            entry.data["Issue Description"] === currentItIssueDetails["Issue Description"]
        );
        if (existingLog) {
            // Update existing log with ticket_id if present and solved status
            existingLog.data.ticket_id = currentItIssueDetails.ticket_id;
            existingLog.data.solved_status = itIssueSolved; // true, false, or null (if conversation ended before resolution)
        } else {
            // This case should ideally not happen if logged correctly during function call
            conversationLog.push({
                type: 'it_support_final_status', // A different type if needed
                data: { ...currentItIssueDetails, solved_status: itIssueSolved }
            });
        }
    }


    if (conversationLog.some(entry => entry.type === 'medical_appointment' || entry.type === 'movie_booking' || entry.type === 'it_support_logged' || entry.type === 'order_tracking')) {
      try {
        let emailHtml = `<h2>Conversation Summary & Actions</h2>`;

        // Add full conversation transcript to email for context
        emailHtml += `<h3>Full Conversation Transcript:</h3><div style="background: #eee; padding: 10px; border-radius: 5px; margin-bottom:20px;">`;
        // conversationLog.forEach(entry => {
        //     if (entry.type === 'user_utterance') {
        //          emailHtml += `<p style="color: #003366; margin: 2px 0;"><strong>User:</strong> ${entry.text}</p>`;
        //     } else if (entry.type === 'assistant_response') {
        //          emailHtml += `<p style="color: #555; margin: 2px 0;"><strong>Assistant:</strong> ${entry.text}</p>`;
        //     }
        // });
        // emailHtml += `</div><h3>Key Actions:</h3>`;


        conversationLog.forEach(entry => {
          // ... (medical_appointment and movie_booking email logic remains the same)
          if (entry.type === "medical_appointment") {
            const appointment = entry.data;
            // ... (existing formatting) ...
            const appointmentDateStr = appointment["Appointment Date & Time"] || "Not specified";
            let formattedDate = appointmentDateStr;
            try {
                if (appointmentDateStr !== "Not specified") {
                    formattedDate = new Date(appointmentDateStr).toLocaleString("en-US", {
                        weekday: "long", year: "numeric", month: "long", day: "numeric",
                        hour: "numeric", minute: "2-digit", hour12: true,
                    });
                }
            } catch (e) { console.warn("Could not parse appointment date:", appointmentDateStr); }

            emailHtml += `
              <div style="border-left: 4px solid #007bff; padding: 15px; margin: 15px 0; background: #f9f9f9; border-radius: 5px;">
                <h4>Medical Appointment Scheduled:</h4>
                <p style="margin: 8px 0;"><strong>👨‍⚕️ Doctor Name:</strong> ${appointment["Doctor Name"] || "N/A"}</p>
                <p style="margin: 8px 0;"><strong>🙍‍♂️ Caller Name:</strong> ${appointment["Caller Name"] || "N/A"}</p>
                <p style="margin: 8px 0;"><strong>📞 Phone:</strong> ${appointment["Phone"] || "N/A"}</p>
                <p style="margin: 8px 0;"><strong>📧 Email:</strong> ${appointment["Email"] || "N/A"}</p>
                <p style="margin: 8px 0;"><strong>📅 Appointment Date & Time:</strong> ${formattedDate}</p>
              </div>`;
          } else if (entry.type === "movie_booking") {
            const booking = entry.data;
            // ... (existing formatting) ...
            const showDateTimeStr = booking["Show Date & Time"] || "Not specified";
            let formattedShowTime = showDateTimeStr;
             try {
                if (showDateTimeStr !== "Not specified") {
                    formattedShowTime = new Date(showDateTimeStr).toLocaleString("en-US", {
                        weekday: "long", year: "numeric", month: "long", day: "numeric",
                        hour: "numeric", minute: "2-digit", hour12: true,
                    });
                }
            } catch (e) { console.warn("Could not parse show date:", showDateTimeStr); }
            emailHtml += `
              <div style="border-left: 4px solid #28a745; padding: 15px; margin: 15px 0; background: #f9f9f9; border-radius: 5px;">
                <h4>Movie Tickets Booked:</h4>
                <p style="margin: 8px 0;"><strong>🎬 Movie Name:</strong> ${booking["Movie Name"] || "N/A"}</p>
                <p style="margin: 8px 0;"><strong>👤 User Name:</strong> ${booking["User Name"] || "N/A"}</p>
                <p style="margin: 8px 0;"><strong>🎟️ Number of Tickets:</strong> ${booking["Number of Tickets"] || "N/A"}</p>
                <p style="margin: 8px 0;"><strong>📅 Show Date & Time:</strong> ${formattedShowTime}</p>
              </div>`;
          } else if (entry.type === "it_support_logged" || entry.type === 'it_support_final_status') { // Check existing log entry
            const itIssue = entry.data;
            emailHtml += `
              <div style="border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; background: #f9f9f9; border-radius: 5px;">
                <h4>IT Support Interaction:</h4>
                <p style="margin: 8px 0;"><strong>👤 User Name:</strong> ${itIssue["User Name"] || "N/A"}</p>
                <p style="margin: 8px 0;"><strong>🆔 Employee ID:</strong> ${itIssue["Employee ID"] || "N/A"}</p>
                <p style="margin: 8px 0;"><strong>📝 Issue Description:</strong> ${itIssue["Issue Description"] || "N/A"}</p>`;

            if (itIssue.solved_status === true) {
              emailHtml += `<p style="margin: 8px 0; color: green;"><strong>Status: Issue reported as SOLVED by user after suggestions.</strong></p>
                            <p style="margin: 8px 0;"><em>Summary of conversation is included above.</em></p>`;
            } else if (itIssue.solved_status === false && itIssue.ticket_id) {
              emailHtml += `<p style="margin: 8px 0; color: red;"><strong>Status: Issue NOT solved. Ticket Created.</strong></p>
                            <p style="margin: 8px 0;"><strong>🎫 Ticket ID:</strong> ${itIssue.ticket_id}</p>
                            <p style="margin: 8px 0;"><em>An agent will get in touch with ${itIssue["User Name"]} shortly regarding this ticket.</em></p>`;
            } else if (itIssue.solved_status === false) {
                 emailHtml += `<p style="margin: 8px 0; color: orange;"><strong>Status: Issue reported as NOT SOLVED, but ticket creation was not confirmed in conversation / call ended.</strong></p>
                               <p style="margin: 8px 0;"><em>Please review transcript for details.</em></p>`;
            } else { // itIssueSolved is null (conversation ended before resolution confirmed)
                 emailHtml += `<p style="margin: 8px 0; color: #555;"><strong>Status: Issue logged, but resolution status not determined during the call.</strong></p>
                               <p style="margin: 8px 0;"><em>Please review transcript for details.</em></p>`;
            }
            emailHtml += `</div>`;
          } else if( entry.type === "order_tracking") {
            const orderTrackingData = entry.data;
            const customerName = orderTrackingData["Customer Name"];
            const orderId = orderTrackingData["Order ID"];

            const orderDetails = dummyOrderData[orderId]; // Look up the order details

            emailHtml += `
              <div style="border-left: 4px solid #17a2b8; padding: 15px; margin: 15px 0; background: #f9f9f9; border-radius: 5px;">
                <h4>Customer Order Tracking Interaction:</h4>
                <p style="margin: 8px 0;"><strong>👤 Customer Name:</strong> ${customerName || "N/A"}</p>
                <p style="margin: 8px 0;"><strong>📦 Provided Order ID:</strong> ${orderId || "N/A"}</p>
            `;
            if (orderDetails) {
              // Order ID found in dummy data
              emailHtml += `<h5 style="margin-top: 15px; margin-bottom: 8px;">Details Found:</h5>`;
              emailHtml += `<p style="margin: 8px 0;"><strong>Status:</strong> ${orderDetails.Status}</p>`;
              if (orderDetails.Status === "Delivered") {
                 emailHtml += `<p style="margin: 8px 0;"><strong>Delivered Date:</strong> ${orderDetails["Delivered Date"]}</p>`;
              } else {
                 emailHtml += `<p style="margin: 8px 0;"><strong>Estimated Delivery:</strong> ${orderDetails["Estimated Delivery"]}</p>`;
              }
              emailHtml += `<p style="margin: 8px 0;"><strong>Carrier:</strong> ${orderDetails.Carrier}</p>`;
            } else {
              // Order ID not found in dummy data
              emailHtml += `<p style="margin: 8px 0; color: #dc3545;"><strong>Result: Order ID ${orderId || "N/A"} not found in the provided dummy data.</strong></p>`;
            }

            emailHtml += `</div>`; 
          }
        });

        if (emailHtml === `<h2>Conversation Summary & Actions</h2><h3>Full Conversation Transcript:</h3><div style="background: #eee; padding: 10px; border-radius: 5px; margin-bottom:20px;"></div><h3>Key Actions:</h3>`) {
            emailHtml += "<p>No specific tool-based actions were completed in this call, or data was not captured.</p>";
        }

        console.log("Attempting to send email...");
        let res = await resend.emails.send({
          from: "noreplay@updates.stackdeveloper.in",
          to: ["blikhitsrisai@gmail.com", "rohitprabha1234@gmail.com"],
          replyTo: "rohitprabha1234@gmail.com",
          subject: "Call Summary: Actions",
          html: emailHtml,
        });
        console.log("Email sent successfully:", res.id || res);
      } catch (error) {
        console.error("Error sending email:", error.response ? JSON.stringify(error.response.data) : error.message, error.stack);
      }
    } else {
        console.log("No tool-based actions in conversationLog to email.");
    }

    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
      console.log("OpenAI WebSocket closed.");
    }
  });

  openaiWs.on("error", (error) => { 
    console.error("OpenAI WebSocket error:", error);
        if (twilioWs.readyState === WebSocket.OPEN) {
            // Optional: Inform Twilio connection if OpenAI fails catastrophically
            // twilioWs.close(1011, "OpenAI connection error");
        }
   });
}

// ... (sendMark, handleSpeechInterruption, initializeSession, sendInitialGreetingPrompt remain the same) ...
// Make sure these functions are correctly defined as in the previous working version.

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
    const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
    // const truncateEvent = { ... }; // As discussed, truncation mechanism needs verification for "Realtime Models"
    const truncateEvent = {
      type: "conversation.item.truncate", // This type is from older/different API docs, Realtime Models might have a different mechanism or rely on just clearing the buffer.
      // For now, assuming a similar truncate concept applies or that clearing Twilio buffer + new input is enough.
      // The new docs don't explicitly show `conversation.item.truncate`.
      // A more robust interruption might involve sending a `response.cancel` or just relying on the new audio input to supersede.
      // Let's send a clear to Twilio and see if the new audio to OpenAI is sufficient.
      item_id: assistantAudioItemId,
      content_index: 0,
      audio_end_ms: elapsedTime > 0 ? elapsedTime : 1, // Must be > 0
    };
    // openaiWs.send(JSON.stringify(truncateEvent));

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
      temperature: 0.7,
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
          text: "Please greet the user warmly as, 'Hello! I am Jane, How may I assist you today?'",
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