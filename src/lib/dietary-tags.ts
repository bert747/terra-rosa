// The baseline meal plan is vegetarian by default, so the curated list only
// covers exceptions to that — not a full meat/veg taxonomy.
export const STANDARD_DIETARY_TAGS = ["Gluten-Free", "Dairy-Free", "Nut-Allergy"];

export function splitDietaryTags(text: string): string[] {
  return text
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinDietaryTags(tags: string[]): string {
  return tags.map((t) => t.trim()).filter(Boolean).join(", ");
}

export function normaliseDietaryTag(tag: string): string {
  return tag.trim().toUpperCase();
}
