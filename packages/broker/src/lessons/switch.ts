// Lessons reach the agent: the install switch. Approved lessons are loaded into an agent's prompt only where this is on. It is SEPARATE from the Team record flag (TEAM_RECORD_ENABLED): turning the
// record on (to collect, show and erase things) must not by itself start sending lessons to agents, because a project's learning mode defaults to On. A packed broker setting (stack parameter
// LearnedLessonsEnabled, "0" by default) that reaches the broker as LEARNED_LESSONS_ENABLED; on only when it is exactly "1". Leaf module (no broker imports).
import { BROKER_SETTINGS, liveInteractionFlagOn } from "@agentx/contracts";

/** Whether approved lessons may be loaded into an agent in this install. Anything but exactly "1" (unset, empty, "true", " 1") is off. */
export const learnedLessonsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.learnedLessons.variable]);

/** The same switch, failing closed: a read that throws (an unreadable environment) is off. Every model path asks this form (owner decision 47). */
export const learnedLessonsOn = (env: NodeJS.ProcessEnv = process.env): boolean => { try { return learnedLessonsEnabled(env); } catch { return false; } };
