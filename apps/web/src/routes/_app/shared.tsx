import { createFileRoute } from '@tanstack/react-router';
import { Page } from '../../app/page.js';
import { SharedArtifactsPage } from '../../features/artifacts/shared-page.js';

export const Route = createFileRoute('/_app/shared')({
  component: () => (
    <Page title="Shared with your organization">
      <SharedArtifactsPage />
    </Page>
  ),
});
