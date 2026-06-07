import { useCallback, useRef, useState } from "react";

/**
 * Inline two-step confirmation for destructive actions.
 *
 * Usage:
 *   const confirm = useInlineConfirm(3000);
 *   // First click:
 *   <Button onClick={confirm.handleConfirm(() => doSomething())}>完成</Button>
 *   // When confirming === true, render the confirm UI:
 *   {confirm.confirming
 *     ? <><Button onClick={confirm.execute}>确认完成？</Button><Button onClick={confirm.cancel}>取消</Button></>
 *     : <Button onClick={...}>完成</Button>
 *   }
 */
export function useInlineConfirm(autoRevertMs = 3000) {
  const [confirming, setConfirming] = useState(false);
  const actionRef = useRef<(() => void | Promise<void>) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    setConfirming(false);
    actionRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleConfirm = useCallback(
    (action: () => void | Promise<void>) => {
      return () => {
        if (confirming) {
          // Second click — execute
          const fn = actionRef.current;
          cancel();
          fn?.();
        } else {
          // First click — enter confirming state
          actionRef.current = action;
          setConfirming(true);
          timerRef.current = setTimeout(cancel, autoRevertMs);
        }
      };
    },
    [confirming, cancel, autoRevertMs],
  );

  return { confirming, handleConfirm, cancel };
}
