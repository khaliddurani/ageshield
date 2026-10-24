import { useEffect, useState } from 'react';
import { getMe } from './api/me';
import { Loading } from './components/common';
import { setStoreTimeZone } from './time';
import { Dashboard } from './pages/Dashboard';
import { Plans } from './pages/Plans';
import { NotFound } from './pages/NotFound';
import { t } from './i18n';
import { useAppBridgeNavigation, usePathname } from './router';

function Route({ pathname }: { pathname: string }) {
  if (pathname === '/' || pathname === '') return <Dashboard />;
  // Also Shopify's welcome link after choosing a plan (/plans?plan_handle=…).
  if (pathname === '/plans') return <Plans />;
  return <NotFound />;
}

export function App() {
  const pathname = usePathname();
  useAppBridgeNavigation();
  // The store's time zone is needed before dates are shown; if /api/me fails, pages use the browser's zone.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    getMe().then(
      (me) => {
        setStoreTimeZone(me.timeZone);
        setReady(true);
      },
      () => setReady(true),
    );
  }, []);
  return (
    <>
      <s-app-nav>
        <s-link href="/" rel="home">
          {t('nav.dashboard')}
        </s-link>
        <s-link href="/plans">{t('nav.plans')}</s-link>
      </s-app-nav>
      {ready ? (
        <Route pathname={pathname} />
      ) : (
        <s-page>
          <Loading />
        </s-page>
      )}
    </>
  );
}
