import { createFileRoute } from '@tanstack/react-router';
import { ModelsSettings } from '../../../features/models/models-settings.js';

export const Route = createFileRoute('/_app/settings/models')({
  component: Models,
});

function Models() {
  const { me } = Route.useRouteContext();
  return <ModelsSettings canEdit={me.role === 'admin'} />;
}
