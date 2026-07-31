"use client";

import { useMemo, useRef, useState } from "react";

interface DietaryTagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
  placeholder?: string;
}

/**
 * Gmail-labels-style multi-select: selected tags render as removable pills
 * inside the field, typing filters an autocomplete dropdown, and anything
 * not in the suggestion list can still be added as a free-form custom tag.
 */
export default function DietaryTagInput({ tags, onChange, suggestions, placeholder }: DietaryTagInputProps) {
  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedKeys = useMemo(() => new Set(tags.map((t) => t.toLowerCase())), [tags]);

  const filteredSuggestions = useMemo(() => {
    const query = inputValue.trim().toLowerCase();
    return suggestions.filter((s) => {
      if (selectedKeys.has(s.toLowerCase())) return false;
      if (!query) return true;
      return s.toLowerCase().includes(query);
    });
  }, [suggestions, selectedKeys, inputValue]);

  const trimmedInput = inputValue.trim();
  const canCreateCustom =
    trimmedInput.length > 0 && !suggestions.some((s) => s.toLowerCase() === trimmedInput.toLowerCase());

  function addTag(tag: string) {
    const clean = tag.trim();
    if (!clean || selectedKeys.has(clean.toLowerCase())) {
      setInputValue("");
      return;
    }
    onChange([...tags, clean]);
    setInputValue("");
    setHighlighted(0);
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  const options = canCreateCustom ? [...filteredSuggestions, trimmedInput] : filteredSuggestions;

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if ((e.key === "Enter" || e.key === "," || e.key === "Tab") && inputValue.trim()) {
      e.preventDefault();
      const chosen = open && options[highlighted] ? options[highlighted] : inputValue;
      addTag(chosen);
      return;
    }
    if (e.key === "Backspace" && inputValue === "" && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => Math.min(h + 1, Math.max(options.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <div
        className="tr-tag-input"
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((tag) => (
          <span key={tag} className="tr-tag-pill">
            {tag}
            <button
              type="button"
              className="tr-tag-pill-remove"
              aria-label={`Remove ${tag}`}
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="tr-tag-input-field"
          value={inputValue}
          placeholder={tags.length === 0 ? placeholder : undefined}
          onChange={(e) => {
            setInputValue(e.target.value);
            setHighlighted(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {open && options.length > 0 && (
        <ul className="tr-tag-dropdown">
          {filteredSuggestions.map((option, index) => (
            <li key={option}>
              <button
                type="button"
                className={`tr-tag-option${index === highlighted ? " tr-tag-option-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addTag(option)}
              >
                {option}
              </button>
            </li>
          ))}
          {canCreateCustom && (
            <li>
              <button
                type="button"
                className={`tr-tag-option${filteredSuggestions.length === highlighted ? " tr-tag-option-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addTag(trimmedInput)}
              >
                Add "{trimmedInput}"
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
