# Backlog Tracker

## TL;DR

This is a blank repo. Our goal is to build a working web app, deployed to production, test suites passing, CI/CD working, at least the major functionality working, etc., following all the practices and processes outlined in my skill library (cboone/agent-harness-plugins ~/Development/agent-harness-plugins). To summarize, the app is simple: A user auths with GitHub SSO, selects on of their repos, and the app creates an issue board modeled after the one created by the new `/add-issue-report` skill.

Please interview me to nail down the details. Ask comprehensive questions. Then complete the entire project, only stopping for reasons described below. Keep working until it's done.

## Approach

You should work continuously until the project as described here is done. Please follow our normal process: Review everything, assemble requirements, etc. Ask me questions to nail down details. Create a high level, comprehensive, phased plan. For each phase, follow our standard PR process: Review the state of the codebase, plans, docs, and issues. Create a detailed plan for the phase. Take a second review pass over it. Work through it, either by issue if that makes sense or by phase if that does, committing as you go, and working in a distinct worktree. Once it's working, tested, and documented, take a final review pass over it. Create a PR, then monitor the PR until it's confirmed clean. Merge with a merge commit, delete the branches and the worktree. Proceed to the next phase.

Please take time to review the skill library as well as some of my repos, perhaps focusing on the ones under more active development. Get a sense of the plan, work, review, PR, merge workflow.

## General guidelines

- The scope of this project only extends to my repos, which are cboone/* repos that are not forks and not archives.
- If you need me to auth anything, just say. If possible, don't let that hold you up though, find something else to work on while you're waiting for my help.
- Same for any interesting or important questions, concerns, etc. Please raise them, but also try to find ways to continue getting work done without being totally blocked.
- For anything that's not covered here or elsewhere in the docs skills etc: If it's low risk, try to figure out how we've handled similar things in the past and follow that pattern. If it's high risk, assess the previous patterns and raise it to me for my choice.
- In general, try to keep going. This is a small project; the cost of redoing parts of it is low. This will be a first draft, with many opportunities to refine and improve and expand. That said, I would like it to be fully working, at least within the limited initial scope.

## Tech etc

Javascript front-end app, minimal back end. If the JS can be kept super simple, I prefer Alpine.js. If not, React is fine. Tailwind CSS. Deploy to Netlify, as my other apps do. Review my repos and skills to see other tech standards.

MIT license.

The README should be user focused, meaning how to get it working on your repo ASAP. Dev docs should be subsidiary.

Include comprehensive testing, at all levels.
