export interface ParticipantInput {
  // Existing participant id — pass back what the dialog was given for rows
  // that were kept, so the row (and its settlements) survive an edit.
  id?: string;
  personName: string;
  expectedAmountPaise: number;
}

export function pickParticipantInput(participant: ParticipantInput): ParticipantInput {
  return {
    ...(participant.id !== undefined ? { id: participant.id } : {}),
    personName: participant.personName,
    expectedAmountPaise: participant.expectedAmountPaise,
  };
}
