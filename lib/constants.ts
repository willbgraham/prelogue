import type { UserRole } from "./types";

export const ROLE_OPTIONS: { value: UserRole; label: string; icon: string; description: string }[] = [
  {
    value: "writer",
    label: "Writer",
    icon: "edit-3",
    description: "Upload scripts, cast actors, and produce table reads",
  },
  {
    value: "actor",
    label: "Actor",
    icon: "video",
    description: "Browse scripts, audition for roles, and build your portfolio",
  },
  {
    value: "audience",
    label: "Audience",
    icon: "eye",
    description: "Watch table reads, vote for your favorites, and discover talent",
  },
];

export const GENRES = [
  "Action",
  "Adventure",
  "Animation",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Family",
  "Fantasy",
  "Historical",
  "Horror",
  "Musical",
  "Mystery",
  "Romance",
  "Sci-Fi",
  "Thriller",
  "War",
  "Western",
  "Other",
] as const;

export type Genre = (typeof GENRES)[number];

export const SCRIPT_STATUS_LABELS: Record<string, string> = {
  open: "Open for Submissions",
  casting: "Casting",
  assembled: "Assembled",
  published: "Published",
};

export const NOTIFICATION_LABELS: Record<string, string> = {
  new_script: "New Script",
  new_submission: "New Submission",
  writers_choice: "Writer's Choice",
  assembly_ready: "Table Read Ready",
  audience_vote: "Audience Vote",
  new_comment: "New Comment",
};
