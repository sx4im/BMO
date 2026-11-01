// Bmo time-of-day and personalized greeting generator.
// Generates short, elegant, single-line greetings tailored to the user's local time
// and display first name.

let _pageGreetingTemplate = null;

export function getFirstName(fullName) {
  if (!fullName || typeof fullName !== "string") return "";
  let cleaned = fullName.trim();
  if (!cleaned || cleaned.toLowerCase() === "bimo user" || cleaned.toLowerCase() === "user") return "";

  // If it is an email address (e.g. user@gmail.com or 123456+username@users.noreply.github.com)
  if (cleaned.includes("@")) {
    cleaned = cleaned.split("@")[0];
    if (cleaned.includes("+")) {
      cleaned = cleaned.split("+")[1] || cleaned;
    }
  }

  // Handle multi-word names like "Saim Shafique" -> "Saim"
  const spaceParts = cleaned.split(/\s+/);
  if (spaceParts.length > 1 && spaceParts[0]) {
    const first = spaceParts[0];
    return first.charAt(0).toUpperCase() + first.slice(1);
  }

  // Handle separated usernames like "saim.shafique", "saim_khan", "saim-dev"
  const raw = cleaned.split(/[\s._-]+/)[0];
  if (!raw) return "";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export const MORNING_GREETINGS = [
  (name) => name ? `Good morning, ${name}` : "Good morning",
  (name) => name ? `Ready to begin, ${name}?` : "Ready to begin?",
  (name) => name ? `Morning, ${name}. Let's dive in` : "Morning. Let's dive in",
  (name) => name ? `What are we starting, ${name}?` : "What are we starting?",
];

export const AFTERNOON_GREETINGS = [
  (name) => name ? `Good afternoon, ${name}` : "Good afternoon",
  (name) => name ? `What's next on your mind, ${name}?` : "What's next on your mind?",
  (name) => name ? `How can I assist, ${name}?` : "How can I assist?",
  (name) => name ? `Ready when you are, ${name}` : "Ready when you are",
];

export const EVENING_GREETINGS = [
  (name) => name ? `Good evening, ${name}` : "Good evening",
  (name) => name ? `What can I do for you, ${name}?` : "What can I do for you?",
  (name) => name ? `Wrapping up your day, ${name}?` : "Wrapping up your day?",
  (name) => name ? `How can I help tonight, ${name}?` : "How can I help tonight?",
];

export const NIGHT_GREETINGS = [
  (name) => name ? `Good night, ${name}` : "Good night",
  (name) => name ? `Still working, ${name}?` : "Still working?",
  (name) => name ? `Quiet night, ${name}` : "Quiet night",
  (name) => name ? `Working late, ${name}?` : "Working late?",
];

export const GENERAL_GREETINGS = [
  (name) => name ? `Hey there, ${name}` : "Hey there",
  (name) => name ? `Welcome back, ${name}` : "Welcome back",
  (name) => name ? `What are we building, ${name}?` : "What are we building?",
  (name) => name ? `How can I help today, ${name}?` : "How can I help today?",
  (name) => name ? `What can I do for you, ${name}?` : "What can I do for you?",
];

export function getGreetingPool(date = new Date()) {
  const hour = date.getHours();
  // Morning: 5am to 12pm (5 <= hour < 12)
  if (hour >= 5 && hour < 12) {
    return MORNING_GREETINGS;
  }
  // Afternoon: 12pm to 5pm (12 <= hour < 17)
  if (hour >= 12 && hour < 17) {
    return AFTERNOON_GREETINGS;
  }
  // Evening: 5pm to 10pm (17 <= hour < 22)
  if (hour >= 17 && hour < 22) {
    return EVENING_GREETINGS;
  }
  // Night: 10pm to 5am (hour >= 22 || hour < 5)
  return NIGHT_GREETINGS;
}

export function getRandomGreetingTemplate(date = new Date()) {
  const pool = getGreetingPool(date);
  return pool[Math.floor(Math.random() * pool.length)];
}

export function getPageGreetingTemplate(date = new Date()) {
  if (!_pageGreetingTemplate) {
    _pageGreetingTemplate = getRandomGreetingTemplate(date);
  }
  return _pageGreetingTemplate;
}

export function resetPageGreetingTemplate() {
  _pageGreetingTemplate = null;
}

export function getGreeting(userName, date = new Date(), template = null) {
  const firstName = getFirstName(userName);
  const fn = template || getPageGreetingTemplate(date);
  return fn(firstName);
}
