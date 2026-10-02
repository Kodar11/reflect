import type { UserContextProvider, UserIntelligenceContext } from './IntelligenceModels.js';

/**
 * TEMPORARY prototype source of the user's context.
 *
 * Onboarding/Settings do not exist yet, so the context is a static object.
 * Replace this class with a Settings-backed `UserContextProvider` later; the
 * intelligence pipeline only depends on the interface.
 *
 * Edit the values below to describe the actual user. Do not add information
 * the user has not provided — the model treats this block as fact.
 */
const PROTOTYPE_USER_CONTEXT: UserIntelligenceContext = {
  role: 'Computer Science student',
  description: 'Builds software projects and studies computer science.',
  currentWork: ['software development', 'learning'],
  importantProjects: ['Reflect'],
  interests: ['game theory', 'volleyball'],
};

export class PrototypeUserContextProvider implements UserContextProvider {
  constructor(private readonly context: UserIntelligenceContext = PROTOTYPE_USER_CONTEXT) {}

  getUserContext(): UserIntelligenceContext {
    return this.context;
  }
}
