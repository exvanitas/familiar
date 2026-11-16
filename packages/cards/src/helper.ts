// The plain helper: the persona Familiar has without a card. No art, a short neutral description,
// neutral traits (even, warm, any) and medium chattiness. The person names her; until then she's
// DEFAULT_HELPER_NAME.
import { NEUTRAL_STATE, type TraitState } from './traits/merge.ts';
import type { Chattiness } from './traits/types.ts';
import type { Card } from './types.ts';

export const DEFAULT_HELPER_NAME = 'Familiar';

export interface PlainHelper {
  readonly card: Card;
  readonly traits: TraitState;
  readonly chattiness: Chattiness;
}

export function plainHelper(name: string = DEFAULT_HELPER_NAME): PlainHelper {
  const clean = name.trim().slice(0, 64) || DEFAULT_HELPER_NAME;
  return {
    card: {
      name: clean,
      description: "{{char}} is a calm, friendly helper who lives on {{user}}'s desktop. {{char}} is plain-spoken, keeps replies short, and says so when unsure.",
      personality: '',
      scenario: '',
      first_mes: 'Hi {{user}}. What can I help with?',
      mes_example: '',
      alternate_greetings: [],
      group_only_greetings: [],
      system_prompt: '',
      post_history_instructions: '',
      creator_notes: '',
      creator: '',
      character_version: '',
      tags: [],
      extensions: {}
    },
    traits: NEUTRAL_STATE,
    chattiness: 'medium'
  };
}
