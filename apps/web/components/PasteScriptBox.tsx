"use client";

/**
 * The box a writer pastes their script into when there's no PDF we can read.
 * Says what shape reads best, because the result depends on it: with no page
 * layout to go by, a speaker is a name in capitals with words under it.
 */
export function PasteScriptBox({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
}) {
  const pages = Math.max(1, Math.round(value.split("\n").length / 56));
  return (
    <div className="flex flex-col gap-1">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={12}
        spellCheck={false}
        aria-label="Script text"
        placeholder={"INT. KITCHEN - NIGHT\n\nEllen waits by the window.\n\nELLEN\nI told you not to call me here.\n\nMARCUS\n(quietly)\nI know."}
        className="w-full rounded-lg border border-tan bg-elevated px-4 py-3 font-mono text-sm leading-relaxed outline-none focus:border-brick disabled:opacity-60"
      />
      <p className="text-xs leading-relaxed text-muted">
        Paste the whole script. It reads best laid out the way a script looks on the page: each
        character&rsquo;s name in CAPITALS on its own line, their words underneath. Fountain and{" "}
        <span className="whitespace-nowrap">&ldquo;NAME: line&rdquo;</span> scripts work too, and you
        can tidy anything afterwards in Edit lines.
        {value.trim().length > 0 && (
          <span className="text-taupe"> About {pages} {pages === 1 ? "page" : "pages"} so far.</span>
        )}
      </p>
    </div>
  );
}
