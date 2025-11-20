import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export async function getNextStep(
  goal: string,
  history: string[],
  htmlConfig: string
) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
    You are an Autonomous Browser Agent.
    
    GOAL: "${goal}"
    HISTORY: ${history.slice(-5).join(" -> ")}
    
    VISIBLE UI ELEMENTS:
    ${htmlConfig}

    ---------------------------------------------------
    INSTRUCTIONS:
    1. Analyze the "VISIBLE UI ELEMENTS".
    2. Pick the SINGLE next logical step.
    3. **CRITICAL**: Use the 'target' field to specify EXACTLY how to find the element. 
       - **PRIORITY 1**: Use 'name' or 'id' attributes (e.g. target: "email").
       - **PRIORITY 2**: Use 'placeholder' or 'label' (e.g. target: "Email address").
       - **PRIORITY 3**: Use visible text (e.g. target: "Sign In").

    OUTPUT SCHEMA (Return RAW JSON object):
    { "action": "click", "target": "..." }
    { "action": "fill", "target": "...", "value": "..." }
    { "action": "press", "key": "Enter" }
    { "action": "finish", "success": true, "desc": "..." }
  `;

  // RETRY LOGIC (FlowTest Style)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();

      // JSON CLEANER: Find the first '{' and last '}' to strip markdown/text
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");

      if (start === -1 || end === -1)
        throw new Error("No JSON found in response");

      const jsonString = text.substring(start, end + 1);
      return JSON.parse(jsonString);
    } catch (e) {
      console.warn(`AI Attempt ${attempt} failed. Retrying...`);
      if (attempt === 3) {
        console.error("AI Failed after 3 attempts:", e);
        // Return a generic wait instead of crashing the whole test
        return { action: "wait", desc: "AI is overloaded, waiting..." };
      }
      // Wait 1s before retry
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
}
