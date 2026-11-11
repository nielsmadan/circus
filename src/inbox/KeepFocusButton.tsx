import type { ButtonHTMLAttributes, ReactElement } from 'react';

export type KeepFocusButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'tabIndex' | 'onMouseDown'
>;

// a click must not move focus off the list, or the inbox keys stop working
export function KeepFocusButton(props: KeepFocusButtonProps): ReactElement {
  return (
    <button
      {...props}
      type="button"
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
    />
  );
}
