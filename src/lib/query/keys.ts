"use client";

export const moneyKeys = {
  all: (userId: string | null) => ["money", userId] as const,
  previews: (userId: string | null) => [...moneyKeys.all(userId), "preview"] as const,
  preview: (userId: string | null, transactionId: string) => [...moneyKeys.previews(userId), transactionId] as const,
  candidates: (userId: string | null) => [...moneyKeys.all(userId), "note-candidates"] as const,
  candidate: (userId: string | null, transactionId: string) => [...moneyKeys.candidates(userId), transactionId] as const,
  categories: (userId: string | null) => [...moneyKeys.all(userId), "category-transactions"] as const,
  category: (userId: string | null, categoryId: string | null, from: string | null, to: string | null) => [...moneyKeys.categories(userId), categoryId, from, to] as const,
};
