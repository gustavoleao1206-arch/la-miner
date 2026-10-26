import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/* Desmonta o que cada teste renderizou. Sem isto, componentes vazam de um teste
   para o outro e uma query `getByText` acha dois elementos onde deveria haver um. */
afterEach(() => {
  cleanup();
});
