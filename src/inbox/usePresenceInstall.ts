import { useCallback, useState } from 'react';
import type { CircusApi } from '../api/client';
import { toCircusError } from '../api/types';
import { errorDetail, presenceFailedToast, presenceOnToast, type ToastSpec } from './messages';

export interface PresenceInstall {
  readonly installing: boolean;
  install(): void;
}

export function usePresenceInstall(
  api: CircusApi,
  notify: (spec: ToastSpec) => void,
  rescan: () => void,
): PresenceInstall {
  const [installing, setInstalling] = useState(false);
  const install = useCallback(() => {
    setInstalling(true);
    api
      .installPresence()
      .then(
        () => {
          notify(presenceOnToast());
          rescan();
        },
        (error: unknown) => notify(presenceFailedToast(errorDetail(toCircusError(error)))),
      )
      .finally(() => setInstalling(false));
  }, [api, notify, rescan]);
  return { installing, install };
}
