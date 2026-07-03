import { RETURN_VALUE_CONTRACT } from "../constants.js";
import { schemaInstruction } from "./schema.js";

const FOLLOW_THROUGH_BLOCK = [
  "<default_follow_through_policy>",
  "Never stop to ask questions or wait for confirmation. Act on the stated defaults, make reasonable assumptions for anything unspecified, and carry the task through to completion.",
  "</default_follow_through_policy>",
].join("\n");

export function assemblePrompt(args: {
  prompt: string;
  schema?: Record<string, unknown>;
  profilePreamble?: string;
}): string {
  const blocks: string[] = [];
  if (args.profilePreamble) blocks.push(args.profilePreamble);
  blocks.push(`<task>\n${args.prompt}\n</task>`);
  if (args.schema) {
    blocks.push(`${RETURN_VALUE_CONTRACT}\n${schemaInstruction(args.schema)}`);
  } else {
    blocks.push(`<compact_output_contract>\n${RETURN_VALUE_CONTRACT}\n</compact_output_contract>`);
  }
  blocks.push(FOLLOW_THROUGH_BLOCK);
  return blocks.join("\n\n");
}
