/** Data-only register: safe to import with Node native type stripping, without app dependencies. */
export type Area = "transactions" | "reimbursements" | "people" | "dashboard" | "spend" | "connections" | "import" | "assistant";
export interface Capability {
  id: string;
  summary: string;
  kind: "read" | "write";
  impl: "effect" | "promise";
  core: { module: string; export: string } | null;
  read?: { module: string; export: string };
  app: { actions: string[] } | { none: string };
  mcp: { tools: { name: string; scope: "read" | "propose" | "write" }[] } | { none: string };
  guards: string[];
  idempotent: "mcp-key" | "none";
  undoable: boolean;
  logged: boolean;
  moneyRules: { module: string; export: string }[];
  refresh: Area[];
}

export const AREA_PATHS: Record<Area, string[]> = {
  "transactions": [
    "/transactions",
    "/review"
  ],
  "reimbursements": [
    "/reimbursements"
  ],
  "people": [
    "/people"
  ],
  "dashboard": [
    "/",
    "/timeline"
  ],
  "spend": [
    "/spend"
  ],
  "connections": [
    "/connections"
  ],
  "import": [
    "/import"
  ],
  "assistant": [
    "/assistant"
  ]
};

export const CAPABILITIES: readonly Capability[] = [
  { id: "settlement.payments", summary: "Tenant-scoped available settlement payments.", kind: "read", impl: "effect", core: null,
    read: { module: "src/lib/ledger/read/settlement-payments.ts", export: "loadSettlementPayments" },
    app: { none: "Available for future settlement screens." }, mcp: { none: "MCP shares inflowExplanation; retains partially acknowledged unlinked credits." },
    guards: ["account ownership", "user-scoped people and payees", "unexplained payments"], idempotent: "none", undoable: false, logged: false,
    moneyRules: [{ module: "src/lib/ledger/rules/settlement-policy.ts", export: "inflowExplanation" }], refresh: [] },

  {
    "id": "transaction.fields",
    "summary": "Categories, notes, transfer/review flags, bulk notes, payee category apply, tag apply/undo and auto-detect transfers.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/transaction-fields.ts",
      "export": "editTransactionFields"
    },
    "app": {
      "actions": [
        "setTransactionCategory",
        "applyCategoryToCounterparty",
        "setTransactionTransfer",
        "setTransactionNeedsReview",
        "setTransactionNote",
        "applyNoteToTransactions",
        "autoDetectTransfers",
        "applySuggestedTags",
        "undoSuggestedTags"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "update_transactions",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "txn rev",
      "expected category",
      "expected note"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [
      {
        "module": "src/lib/ledger/rules.ts",
        "export": "afterFields"
      },
      {
        "module": "src/lib/ledger/rules.ts",
        "export": "guardMatches"
      },
      {
        "module": "src/lib/ledger/rules.ts",
        "export": "sameFields"
      }
    ],
    "refresh": [
      "transactions",
      "dashboard",
      "connections"
    ]
  },
  {
    "id": "payee.default",
    "summary": "Set or clear a payee default category.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/payee-default.ts",
      "export": "setPayeeDefault"
    },
    "app": {
      "actions": [
        "rememberPayeeDefault"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "set_payee_default",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "current default"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "transactions",
      "dashboard",
      "connections"
    ]
  },
  {
    "id": "split.create",
    "summary": "createSplit through the actor-scoped ledger.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/splits.ts",
      "export": "createSplit"
    },
    "app": {
      "actions": [
        "createSplit"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "create_split",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "txn rev",
      "split_rev",
      "no settled replacement"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [
  {
    "module": "src/lib/splits/validate.ts",
    "export": "validateSplitInput"
  },
  {
    "module": "src/lib/splits/validate.ts",
    "export": "validateSplitTotalMatchesTransaction"
  },
  {
    "module": "src/lib/splits/validate.ts",
    "export": "validateParticipantIdsBelongToSplit"
  },
  {
    "module": "src/lib/splits/validate.ts",
    "export": "validateSettledParticipantEdit"
  },
  {
    "module": "src/lib/splits/validate.ts",
    "export": "validatePayableReplaceable"
  }
],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "split.delete",
    "summary": "deleteSplit through the actor-scoped ledger.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/splits.ts",
      "export": "deleteSplit"
    },
    "app": {
      "actions": [
        "deleteSplit"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "delete_split",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "txn rev",
      "split_rev",
      "no settlements"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "settlement.bank.record",
    "summary": "recordSettlement through the actor-scoped ledger.",
    "kind": "write",
    "impl": "effect",
    "core": {
      "module": "src/lib/ledger/splits.ts",
      "export": "recordSettlement"
    },
    "app": {
      "actions": [
        "recordSettlement"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "record_settlement",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "expected allocations",
      "txn rev"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [
      {
        "module": "src/lib/ledger/rules/settlement-policy.ts",
        "export": "allocateOldestFirst"
      },
      {
        "module": "src/lib/ledger/rules/settlement-policy.ts",
        "export": "validateAllocations"
      },
      {
        "module": "src/lib/ledger/rules/settlement-policy.ts",
        "export": "inflowExplanation"
      },
      {
        "module": "src/lib/ledger/rules/settlement-policy.ts",
        "export": "appendAllowed"
      },
      {
        "module": "src/lib/ledger/rules/settlement-policy.ts",
        "export": "sameAllocations"
      },
      {
        "module": "src/lib/ledger/rules/settlement-policy.ts",
        "export": "settlementReceipt"
      },
      {
        "module": "src/lib/ledger/rules/balances.ts",
        "export": "outstandingPaise"
      }
    ],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "settlement.bank.clear",
    "summary": "clearSettlement through the actor-scoped ledger.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/splits.ts",
      "export": "clearSettlement"
    },
    "app": {
      "actions": [
        "clearSettlement"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "clear_settlement",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "expected relations"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "settlement.cash.record",
    "summary": "recordCashSettlement through the actor-scoped ledger.",
    "kind": "write",
    "impl": "effect",
    "core": {
      "module": "src/lib/ledger/settlements.ts",
      "export": "recordCashSettlement"
    },
    "app": {
      "actions": [
        "recordCashSettlement"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "record_cash_settlement",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "outstanding balance"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [
      {
        "module": "src/lib/ledger/rules/balances.ts",
        "export": "outstandingPaise"
      },
      {
        "module": "src/lib/ledger/rules/settlement-policy.ts",
        "export": "cashAmountCheck"
      }
    ],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "settlement.cash.delete",
    "summary": "deleteCashSettlement through the actor-scoped ledger.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/settlements.ts",
      "export": "deleteCashSettlement"
    },
    "app": {
      "actions": [
        "deleteCashSettlement"
      ]
    },
    "mcp": {
      "none": "No dedicated MCP operation; use undo_change for reversal."
    },
    "guards": [
      "cash method"
    ],
    "idempotent": "none",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "transactions",
      "dashboard",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "settlement.writeoff",
    "summary": "writeOffParticipantShare through the actor-scoped ledger.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/settlements.ts",
      "export": "writeOffParticipantShare"
    },
    "app": {
      "actions": [
        "writeOffParticipantShare"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "write_off_share",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "outstanding balance"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "settlement.writeoff.undo",
    "summary": "undoWriteOff through the actor-scoped ledger.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/settlements.ts",
      "export": "undoWriteOff"
    },
    "app": {
      "actions": [
        "undoWriteOff"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "undo_write_off",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "writeoff method"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "net.save",
    "summary": "saveNetEvent through the actor-scoped ledger.",
    "kind": "write",
    "impl": "effect",
    "core": {
      "module": "src/lib/ledger/net-events.ts",
      "export": "saveNetEvent"
    },
    "app": {
      "actions": [
        "saveNetEvent"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "net_settle",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "no existing event",
      "expected relations", "expected outstanding per target", "cash today Asia/Kolkata", "cash excludes bank", "bank direction", "no split outflow", "unexplained inflow"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [
      { "module": "src/lib/ledger/rules/net-settlement.ts", "export": "netSettlementReceipt" },
      { "module": "src/lib/ledger/rules/net-settlement.ts", "export": "netSettlementDate" },
      { "module": "src/lib/ledger/rules/net-settlement-plan.ts", "export": "guidedSettlementLegs" },
      { "module": "src/lib/ledger/rules/settlement-policy.ts", "export": "inflowExplanation" },
      { "module": "src/lib/ledger/rules/balances.ts", "export": "outstandingPaise" },
      {
        "module": "src/lib/net-events/validate.ts",
        "export": "validateNetEventInvariant"
      }
    ],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "net.delete",
    "summary": "deleteNetEvent through the actor-scoped ledger.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/net-events.ts",
      "export": "deleteNetEvent"
    },
    "app": {
      "actions": [
        "deleteNetEvent"
      ]
    },
    "mcp": {
      "none": "No dedicated MCP operation; use undo_change for reversal."
    },
    "guards": [
      "expected relations"
    ],
    "idempotent": "none",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "transactions",
      "dashboard",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "owed.create",
    "summary": "createOwedExpense through the actor-scoped ledger.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/owed-expenses.ts",
      "export": "createOwedExpense"
    },
    "app": {
      "actions": [
        "createOwedExpense"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "add_owed_expense",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "source capacity"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [
      {
        "module": "src/lib/ledger/owed-capacity.ts",
        "export": "sourceInflowCapacity"
      }
    ],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "owed.update",
    "summary": "updateOwedExpense through the actor-scoped ledger.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/owed-expenses.ts",
      "export": "updateOwedExpense"
    },
    "app": {
      "actions": [
        "updateOwedExpense"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "update_owed_expense",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "settled minimum",
      "source capacity"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [
      {
        "module": "src/lib/ledger/owed-capacity.ts",
        "export": "sourceInflowCapacity"
      }
    ],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "owed.delete",
    "summary": "deleteOwedExpense through the actor-scoped ledger.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/owed-expenses.ts",
      "export": "deleteOwedExpense"
    },
    "app": {
      "actions": [
        "deleteOwedExpense"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "delete_owed_expense",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "expected relations"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "payee.rename",
    "summary": "Rename a payee with current-name confirmation.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/metadata.ts",
      "export": "renamePayee"
    },
    "app": {
      "none": "App has no logged rename action; MCP exposes this core."
    },
    "mcp": {
      "tools": [
        {
          "name": "rename_payee",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "current display name"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "standing-note.add",
    "summary": "Add a logged, unredacted standing note.",
    "kind": "write",
    "impl": "effect",
    "core": {
      "module": "src/lib/ledger/standing-notes.ts",
      "export": "addStandingNote"
    },
    "app": {
      "actions": [
        "addContextNote"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "add_standing_note",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "500 character limit",
      "40 note cap"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "connections"
    ]
  },
  {
    "id": "standing-note.update",
    "summary": "Edit a logged standing note; saveContextNote with no id adds one through addStandingNote.",
    "kind": "write",
    "impl": "effect",
    "core": {
      "module": "src/lib/ledger/standing-notes.ts",
      "export": "updateStandingNote"
    },
    "app": {
      "actions": [
        "saveContextNote"
      ]
    },
    "mcp": {
      "none": "Agents can add notes and undo their own changes, but have no edit tool yet."
    },
    "guards": [
      "500 character limit"
    ],
    "idempotent": "none",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "connections"
    ]
  },
  {
    "id": "standing-note.delete",
    "summary": "Delete a logged standing note; a missing or foreign id is a quiet no-op.",
    "kind": "write",
    "impl": "effect",
    "core": {
      "module": "src/lib/ledger/standing-notes.ts",
      "export": "deleteStandingNote"
    },
    "app": {
      "actions": [
        "deleteContextNote"
      ]
    },
    "mcp": {
      "none": "Agents can add notes and undo their own changes, but have no delete tool yet."
    },
    "guards": [],
    "idempotent": "none",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "connections"
    ]
  },
  {
    "id": "person.link",
    "summary": "Confirm or clear payee/person links.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/person-links.ts",
      "export": "linkPayeesToPerson"
    },
    "app": {
      "none": "App has no person-link action yet."
    },
    "mcp": {
      "tools": [
        {
          "name": "link_person",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "current_person"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "change.undo",
    "summary": "Undo an unchanged logged change atomically.",
    "kind": "write",
    "impl": "promise",
    "core": {
      "module": "src/lib/ledger/undo.ts",
      "export": "undoChange"
    },
    "app": {
      "actions": [
        "undoLedgerChange"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "undo_change",
          "scope": "write"
        }
      ]
    },
    "guards": [
      "recorded after-values"
    ],
    "idempotent": "mcp-key",
    "undoable": true,
    "logged": true,
    "moneyRules": [
      {
        "module": "src/lib/ledger/rules.ts",
        "export": "inverse"
      }
    ],
    "refresh": [
      "transactions",
      "dashboard",
      "connections",
      "reimbursements",
      "people",
      "spend"
    ]
  },
  {
    "id": "change.list",
    "summary": "Read recent ledger changes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "actions": [
        "listLedgerChanges"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "list_changes",
          "scope": "write"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/ledger/changes.ts",
      "export": "listChanges"
    }
  },
  {
    "id": "statement.import",
    "summary": "Import a bank statement through the Effect ingest pipeline.",
    "kind": "write",
    "impl": "effect",
    "core": {
      "module": "src/domain/ingest/pipeline.ts",
      "export": "ingestStatement"
    },
    "app": {
      "actions": [
        "uploadStatement"
      ]
    },
    "mcp": {
      "none": "PDF upload is available only through the authenticated app form."
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [
      "import",
      "transactions"
    ]
  },
  {
    "id": "balances",
    "summary": "Read or prepare balances without ledger writes.",
    "kind": "read",
    "impl": "effect",
    "core": null,
    "app": {
      "none": "Read directly by server pages; no server action."
    },
    "mcp": {
      "tools": [
        {
          "name": "get_open_balances",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [
      {
        "module": "src/lib/ledger/rules/balances.ts",
        "export": "buildPersonBalances"
      }
    ],
    "refresh": [],
    "read": {
      "module": "src/lib/ledger/read/balances.ts",
      "export": "loadBalances"
    }
  },
  {
    "id": "overview",
    "summary": "Read or prepare overview without ledger writes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "none": "Read directly by server pages; no server action."
    },
    "mcp": {
      "tools": [
        {
          "name": "get_overview",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/mcp/read-ops.ts",
      "export": "mcpReadOps"
    }
  },
  {
    "id": "period.summary",
    "summary": "Spend totals for a period. A net settlement's outflow debit counts as zero spend; raw bank totals still include it.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "none": "Read directly by server pages; no server action."
    },
    "mcp": {
      "tools": [
        {
          "name": "get_period_summary",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/mcp/summary.ts",
      "export": "loadMcpSummary"
    }
  },
  {
    "id": "transactions.list",
    "summary": "Read or prepare transactions.list without ledger writes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "actions": [
        "getCategoryTransactions",
        "getNoteCandidates"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "list_transactions",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/mcp/read-ops.ts",
      "export": "mcpReadOps"
    }
  },
  {
    "id": "transactions.detail",
    "summary": "Read or prepare transactions.detail without ledger writes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "actions": [
        "getLinkedTransactionPreview",
        "loadAssistantTxns"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "get_transactions",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/mcp/model-view.ts",
      "export": "getTransactions"
    }
  },
  {
    "id": "payments.find",
    "summary": "Read or prepare payments.find without ledger writes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "none": "Read directly by server pages; no server action."
    },
    "mcp": {
      "tools": [
        {
          "name": "find_payments",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/mcp/find-payments.ts",
      "export": "findPayments"
    }
  },
  {
    "id": "categories.suggest",
    "summary": "Read or prepare categories.suggest without ledger writes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "actions": [
        "suggestTagChunk"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "suggest_categories",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/mcp/period-review.ts",
      "export": "suggestCategories"
    }
  },
  {
    "id": "period.review",
    "summary": "Read or prepare period.review without ledger writes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "none": "Read directly by server pages; no server action."
    },
    "mcp": {
      "tools": [
        {
          "name": "review_period",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/mcp/period-review.ts",
      "export": "reviewPeriod"
    }
  },
  {
    "id": "query",
    "summary": "Read or prepare query without ledger writes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "none": "Read directly by server pages; no server action."
    },
    "mcp": {
      "tools": [
        {
          "name": "query",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/assistant/query-sandbox.ts",
      "export": "createQuerySandbox"
    }
  },
  {
    "id": "people.list",
    "summary": "Read or prepare people.list without ledger writes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "none": "Read directly by server pages; no server action."
    },
    "mcp": {
      "tools": [
        {
          "name": "list_people",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/mcp/model-view.ts",
      "export": "buildReadView"
    }
  },
  {
    "id": "payees.list",
    "summary": "Read or prepare payees.list without ledger writes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "none": "Read directly by server pages; no server action."
    },
    "mcp": {
      "tools": [
        {
          "name": "list_payees",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/mcp/model-view.ts",
      "export": "pagePayees"
    }
  },
  {
    "id": "standing-notes.list",
    "summary": "Read or prepare standing-notes.list without ledger writes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "actions": [
        "listContextNotesAction"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "list_standing_notes",
          "scope": "read"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/assistant/actor-ops.ts",
      "export": "readStandingNotes"
    }
  },
  {
    "id": "tags.propose",
    "summary": "Read or prepare tags.propose without ledger writes.",
    "kind": "read",
    "impl": "promise",
    "core": null,
    "app": {
      "actions": [
        "openProposedTagDraft",
        "resolveProposedTagDraft"
      ]
    },
    "mcp": {
      "tools": [
        {
          "name": "propose_tags",
          "scope": "propose"
        }
      ]
    },
    "guards": [],
    "idempotent": "none",
    "undoable": false,
    "logged": false,
    "moneyRules": [],
    "refresh": [],
    "read": {
      "module": "src/lib/mcp/proposal.ts",
      "export": "validateTagProposal"
    }
  }
];

export const NON_FINANCIAL_ACTIONS: Record<string, string> = {
  "registerUser": "Authentication registration.",
  "listMcpTokens": "Connection token settings.",
  "createMcpToken": "Connection token settings.",
  "revokeMcpToken": "Connection token settings.",
  "getAssistantBootstrap": "Assistant panel configuration and bootstrap.",
  "assistantTurn": "Assistant orchestration; writes only propose cards.",
  "prepareAssistantOp": "Prepare a pending card without writing.",
  "prepareApplyToAll": "Preview a pending bulk edit without writing."
};

export const NON_FINANCIAL_TOOLS: Record<string, string> = {
  "list_categories": "Category vocabulary lookup.",
  "describe_table": "Query schema documentation."
};

export const LEGACY_PROMISE_CORES: readonly string[] = [
  "transaction.fields",
  "payee.default",
  "split.create",
  "split.delete",
  "settlement.bank.clear",
  "settlement.cash.delete",
  "settlement.writeoff",
  "settlement.writeoff.undo",
  "net.delete",
  "owed.create",
  "owed.update",
  "owed.delete",
  "payee.rename",
  "person.link",
  "change.undo",
  "change.list",
  "overview",
  "period.summary",
  "transactions.list",
  "transactions.detail",
  "payments.find",
  "categories.suggest",
  "period.review",
  "query",
  "people.list",
  "payees.list",
  "standing-notes.list",
  "tags.propose"
];

/** Unknown ids are programmer errors, never silently skip refreshes. */
export function refreshPaths(id: string): string[] {
  const capability = CAPABILITIES.find((entry) => entry.id === id);
  if (!capability) throw new Error(`Unknown capability: ${id}`);
  return [...new Set(capability.refresh.flatMap((area) => AREA_PATHS[area]))];
}
