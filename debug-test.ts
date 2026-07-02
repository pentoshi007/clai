// Test why patterns are matching incorrectly

const BUILD_TASK_RE =
  /\b(?:build|create|scaffold|generate|make|set\s*up|setup|bootstrap|init(?:ialize)?|implement|add|write|develop|code|refactor|migrate|convert|wire\s*up|integrate)\b[\s\S]{0,80}\b(?:app|application|project|site|website|web\s*app|server|api|service|component|page|module|feature|cli|script|library|package|frontend|backend|fullstack|game|bot|dashboard|form|endpoint|database|schema|test|tests|suite|auth|authentication|authorization|login|signup|middleware|route|routes|routing|handler|controller|model|view)\b/i;

const CONTINUATION_RE =
  /^(?:do\s+it|build\s+it|build\s+fully|build\s+it\s+fully|go\s+ahead|continue|proceed|keep\s+going|finish(?:\s+it)?|complete(?:\s+it)?|yes|ok(?:ay)?|make\s+it|run\s+it|next|on\s+your\s+own|build\s+(?:fully\s+)?on\s+your\s+own)\b/i;

const INCOMPLETE_RE =
  /\b(?:not\s+complete|incomplete|isn'?t\s+(?:done|complete|working|finished)|doesn'?t\s+work|still\s+(?:broken|missing|failing)|missing\s+(?:files?|parts?)|finish\s+(?:the|it)|complete\s+(?:the|it))\b/i;

const PLAN_EXECUTION_RE =
  /\b(?:approve the plan|execute it (?:now|task by task)|task by task|execute the plan|implement the plan)\b/i;

const INFORMATIONAL_SIGNAL_RE =
  /\b(?:compare|comparison|contrast|differ(?:ence|ences|s)?|pros\s+and\s+cons|trade-?offs?|versus|vs\.?|cheat\s*sheet|explain|describe|summari[sz]e|overview|tell\s+me)\b/i;

const INTERROGATIVE_LEAD_RE =
  /^(?:what|which|why|how|when|who|where|is|are|do|does|did|can|could|should|would|will)\b/i;

function test(text: string, expectedInfo: boolean) {
  const normalized = text.replace(/\s+/g, " ").trim();
  
  console.log(`\nTesting: "${text}"`);
  console.log(`Expected informational: ${expectedInfo}`);
  
  const buildMatch = BUILD_TASK_RE.test(normalized);
  const contMatch = CONTINUATION_RE.test(normalized);
  const incompleteMatch = INCOMPLETE_RE.test(normalized);
  const planMatch = PLAN_EXECUTION_RE.test(normalized);
  
  console.log(`  BUILD_TASK_RE: ${buildMatch}`);
  console.log(`  CONTINUATION_RE: ${contMatch}`);
  console.log(`  INCOMPLETE_RE: ${incompleteMatch}`);
  console.log(`  PLAN_EXECUTION_RE: ${planMatch}`);
  
  if (buildMatch || contMatch || incompleteMatch || planMatch) {
    console.log(`  -> Returns false (action pattern matched)`);
  } else {
    const endsWithQ = normalized.endsWith("?");
    const interrogative = INTERROGATIVE_LEAD_RE.test(normalized);
    const infoSignal = INFORMATIONAL_SIGNAL_RE.test(normalized);
    
    console.log(`  Ends with '?': ${endsWithQ}`);
    console.log(`  INTERROGATIVE_LEAD_RE: ${interrogative}`);
    console.log(`  INFORMATIONAL_SIGNAL_RE: ${infoSignal}`);
    console.log(`  -> Returns ${endsWithQ || interrogative || infoSignal}`);
  }
}

test("tell me what you learned", true);
test("should I add auth", false);
