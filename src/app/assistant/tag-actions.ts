"use server";

import { defineAction } from "@/lib/action/define-action";
import {
  listContextNotesActionSpec,
  saveContextNoteSpec,
  deleteContextNoteSpec,
  addContextNoteSpec,
  suggestTagChunkSpec,
  applySuggestedTagsSpec,
  undoSuggestedTagsSpec,
  rememberPayeeDefaultSpec,
} from "./tag-handlers";

export const listContextNotesAction = defineAction("listContextNotesAction", listContextNotesActionSpec);
export const saveContextNote = defineAction("saveContextNote", saveContextNoteSpec);
export const deleteContextNote = defineAction("deleteContextNote", deleteContextNoteSpec);
export const addContextNote = defineAction("addContextNote", addContextNoteSpec);
export const suggestTagChunk = defineAction("suggestTagChunk", suggestTagChunkSpec);
export const applySuggestedTags = defineAction("applySuggestedTags", applySuggestedTagsSpec);
export const undoSuggestedTags = defineAction("undoSuggestedTags", undoSuggestedTagsSpec);
export const rememberPayeeDefault = defineAction("rememberPayeeDefault", rememberPayeeDefaultSpec);
