# Six recommended Bimo chat skills

Researched 2026-11-15 from the upstream skill files, not directory descriptions alone. These are recommendations; no skill has been installed, enabled, or added to Bimo by this research.

| Skill | Intended Bimo behavior | Example request | Upstream reference |
| --- | --- | --- | --- |
| Caveman | Concise, answer-first replies that retain technical facts, commands and warnings. User-selectable rather than the default voice. | "Explain Docker in five short lines." | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman/blob/main/skills/caveman/SKILL.md) |
| Humanizer | Rewrite supplied prose in a natural voice without changing supported claims or inventing personal details. Match a writing sample if provided. | "Make this email sound like me." | [blader/humanizer](https://github.com/blader/humanizer/blob/main/SKILL.md) |
| No AI Slop | Audit or lightly edit filler, repetitive structures and vague claims, preserving the writer's voice. Show specific findings when audit mode is selected. | "Flag the generic parts of this paragraph." | [petergyang/no-ai-slop](https://github.com/petergyang/no-ai-slop/blob/main/skills/no-ai-slop/SKILL.md) |
| Socratic Tutor | Optional study sessions: assess understanding, ask one question at a time, offer hints and review earlier material. A normal factual question should still get a direct answer. | "Tutor me on calculus, one question at a time." | [Jane Street/socratic-tutor](https://github.com/janestreet/agent_skills/blob/master/socratic-tutor/SKILL.md) |
| Deep Research | Search multiple relevant sources, inspect evidence, compare claims and cite a focused answer with gaps stated. Trigger for deliberate research, not ordinary conversation. | "Research recent AI regulations in Pakistan with sources." | [ByteDance DeerFlow/deep-research](https://github.com/bytedance/deer-flow/blob/main/skills/public/deep-research/SKILL.md) |
| Brainstorm | Clarify important constraints, propose distinct ideas, compare tradeoffs and narrow to useful options. Adapt the upstream engineering workflow for general chat. | "Give me five practical startup ideas for university students." | [obra/superpowers/brainstorming](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md) |

The last three are my picks because they add learning, evidence gathering, and idea generation beyond the three requested writing styles. This is a product-fit recommendation, not a measured universal ranking.

## Overlap and adaptation

Humanizer and No AI Slop overlap heavily in their actual instructions. The separation above is a proposed Bimo distinction: Humanizer emphasizes rewriting, while No AI Slop emphasizes diagnosis and minimal edits. Upstream No AI Slop supports both edit and detect modes. Neither should be advertised as proving whether AI wrote something, or guaranteeing detection avoidance.

Caveman reduces verbosity; its marketing token-saving numbers are not Bimo benchmarks and do not prove lower time to first response. Keep it optional and preserve accuracy over aggressive shortening. Avoid combining conflicting style skills by default.

Socratic Tutor should activate through selection or explicit teaching intent. Retain its "just tell me" escape so ordinary questions do not become unwanted quizzes. Its progress map is a self-assessment aid, not validated educational measurement.

Brainstorming's upstream includes approval gates, design documents and developer tool workflows. Adapt its constraint discovery and alternatives exploration; do not paste those engineering gates into consumer chats. Deep Research references host tools such as web_fetch; map the methodology to Bimo's real search/read capabilities rather than inventing tools or installing the entire DeerFlow harness.

## Fit with Bimo today

The existing picker and backend allow up to three selected skills per request. Skills are Markdown guidance; they do not install executable tools. Instructions are limited to 20,000 characters per skill and are enclosed as untrusted user-authored guidance beneath Bimo's base rules. Reference text can be imported with the existing ZIP mechanism. Existing implementation references: frontend/js/chat/skill-picker.js and backend/app/skill_service.py.

Load only selected skill text. Start with short Bimo-specific instructions, preserve upstream licenses/attribution, and pin reviewed source revisions before importing. Do not run a separate rewriting model after every ordinary response. Research legitimately requires additional retrieval; keep it explicit and give progress while sources are gathered.

Before release, evaluate English, Urdu and Roman Urdu examples; factual preservation, style conflicts, source faithfulness, tutoring opt-out, prompt injection in drafts/sources, and measured first-response latency. Popular repositories establish provenance, not that these skills have already passed Bimo evaluations.
