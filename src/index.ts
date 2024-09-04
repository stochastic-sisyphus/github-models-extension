import { verifyAndParseRequest, createAckEvent } from "@copilot-extensions/preview-sdk";
import express from "express";
import OpenAI from "openai";

import { describeModel } from "./functions/describe-model.js";
import { executeModel } from "./functions/execute-model.js";
import { listModels } from "./functions/list-models.js";
import { RunnerResponse } from "./functions.js";
import { recommendModel } from "./functions/recommend-model.js";
import { ModelsAPI } from "./models-api.js";

const app = express();

app.post("/", express.text({ type: "*/*" }), async (req, res) => {
  let verifyAndParseRequestResult: Awaited<ReturnType<typeof verifyAndParseRequest>>;
  try {
    const signature = req.get("GitHub-Public-Key-Signature") as string;
    const keyID = req.get("GitHub-Public-Key-Identifier") as string;
    const tokenForUser = req.get("X-GitHub-Token") as string;
    verifyAndParseRequestResult = await verifyAndParseRequest(req.body, signature, keyID, {
      token: tokenForUser,
    });
  } catch (err) {
    console.error(err);
    res.status(401).end("Unauthorized");
    return
  }

  const { isValidRequest, payload } = verifyAndParseRequestResult

  if (!isValidRequest) {
    console.log("Signature verification failed");
    return res.status(401).send("Unauthorized");
  }

  console.log("Signature verified");

  // Use the GitHub API token sent in the request
  const apiKey = req.get("X-GitHub-Token");
  if (!apiKey) {
    res.status(400).end();
    return;
  }

  res.write(createAckEvent().toString());

  // List of functions that are available to be called
  const modelsAPI = new ModelsAPI(apiKey);
  const functions = [listModels, describeModel, executeModel, recommendModel];

  // Use the Copilot API to determine which function to execute
  const capiClient = new OpenAI({
    baseURL: "https://api.githubcopilot.com",
    apiKey,
  });

  // Prepend a system message that includes the list of models, so that
  // tool calls can better select the right model to use.
  const models = await modelsAPI.listModels();
  const toolCallMessages = [
    {
      role: "system",
      content: [
        "You are an extension of GitHub Copilot, built to interact with GitHub Models.",
        "GitHub Models is a language model playground, where you can experiment with different models and see how they respond to your prompts.",
        "Here is a list of some of the models available to the user:",
        "<-- LIST OF MODELS -->",
        JSON.stringify(
          models.map((model) => ({
            friendly_name: model.friendly_name,
            name: model.name,
            publisher: model.publisher,
            registry: model.model_registry,
            description: model.summary,
          }))
        ),
        "<-- END OF LIST OF MODELS -->",
      ].join("\n"),
    },
    ...payload.messages,
  ].concat(payload.messages);

  console.time("tool-call");
  const toolCaller = await capiClient.chat.completions.create({
    stream: false,
    model: "gpt-4",
    messages: toolCallMessages,
    tool_choice: "auto",
    tools: functions.map((f) => f.tool),
  });
  console.timeEnd("tool-call");

  if (
    !toolCaller.choices[0] ||
    !toolCaller.choices[0].message ||
    !toolCaller.choices[0].message.tool_calls ||
    !toolCaller.choices[0].message.tool_calls[0].function
  ) {
    console.log("No tool call found");
    // No tool to call, so just call the model with the original messages
    const stream = await capiClient.chat.completions.create({
      stream: true,
      model: "gpt-4",
      messages: payload.messages,
    });

    for await (const chunk of stream) {
      const chunkStr = "data: " + JSON.stringify(chunk) + "\n\n";
      res.write(chunkStr);
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const functionToCall = toolCaller.choices[0].message.tool_calls[0].function;
  const args = JSON.parse(functionToCall.arguments);

  console.time("function-exec");
  let functionCallRes: RunnerResponse;
  try {
    console.log("Executing function", functionToCall.name);
    const funcClass = functions.find(
      (f) => f.definition.name === functionToCall.name
    );
    if (!funcClass) {
      throw new Error("Unknown function");
    }

    console.log("\t with args", args);
    const func = new funcClass(modelsAPI);
    functionCallRes = await func.execute(payload.messages, args);
  } catch (err) {
    console.error(err);
    res.status(500).end();
    return;
  }
  console.timeEnd("function-exec");

  try {
    const stream = await modelsAPI.inference.chat.completions.create({
      model: functionCallRes.model,
      messages: functionCallRes.messages,
      stream: true,
      stream_options: {
        include_usage: false,
      },
    });

    console.time("streaming");
    for await (const chunk of stream) {
      const chunkStr = "data: " + JSON.stringify(chunk) + "\n\n";
      res.write(chunkStr);
    }
    res.write("data: [DONE]\n\n");
    console.timeEnd("streaming");
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("OK");
});

const port = Number(process.env.PORT || "3000");
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
