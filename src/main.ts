import { fail } from "./action.ts";
import { run } from "./run.ts";

run(process.env).catch(fail);
