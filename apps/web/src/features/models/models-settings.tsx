import { Button } from '@openbot/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createProvider, presetsQuery, providersQuery, type ProviderPreset } from './api.js';
import { AddEndpoint } from './add-endpoint.js';
import { ErrorText } from './error-text.js';
import { BUILT_IN_KINDS } from './format.js';
import { KeyField, ProviderCard } from './provider-card.js';

// Settings > Models (L1 to L5): a card per built-in provider, then custom
// endpoints. Members see instance providers read-only; admins edit (v1).

/** A built-in provider nobody has added yet: saving a key creates it from its preset. */
function UnconfiguredBuiltIn({ preset, canEdit }: { preset: ProviderPreset; canEdit: boolean }) {
  const queryClient = useQueryClient();
  return (
    <article className="flex flex-col gap-3 rounded-md border p-4" aria-label={preset.name}>
      <h3 className="font-medium">{preset.name}</h3>
      <KeyField
        hasKey={false}
        canEdit={canEdit}
        onSave={(apiKey) =>
          createProvider({ presetId: preset.id, apiKey }).then(() =>
            queryClient.invalidateQueries({ queryKey: providersQuery.queryKey }),
          )
        }
      />
    </article>
  );
}

export function ModelsSettings({ canEdit }: { canEdit: boolean }) {
  const providers = useQuery(providersQuery);
  const presets = useQuery(presetsQuery);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<{ id: string; discoverError?: Error } | null>(null);
  const error = providers.error ?? presets.error;
  if (error) return <ErrorText error={error} />;
  if (!providers.data || !presets.data) return null;

  const presetById = new Map(presets.data.items.map((p) => [p.id, p]));
  const custom = providers.data.items.filter((p) => p.kind === 'custom');

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Providers</h2>
        {BUILT_IN_KINDS.map((kind) => {
          const configured = providers.data.items.filter((p) => p.kind === kind);
          const preset = presetById.get(kind);
          if (!configured.length) {
            return preset ? (
              <UnconfiguredBuiltIn key={kind} preset={preset} canEdit={canEdit} />
            ) : null;
          }
          return configured.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} canEdit={canEdit} />
          ));
        })}
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-medium">Custom model providers</h2>
          {canEdit && !adding && (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              Add custom model provider
            </Button>
          )}
        </div>
        {adding && (
          <AddEndpoint
            presets={presets.data.items}
            onAdded={(provider, discoverError) => {
              setAdding(false);
              setAdded({ id: provider.id, discoverError });
            }}
          />
        )}
        {custom.map((provider) => (
          <div key={provider.id} className="flex flex-col gap-1.5">
            {added?.id === provider.id && added.discoverError && (
              <p className="text-sm text-destructive">
                Added, but discovery failed: {added.discoverError.message}
              </p>
            )}
            <ProviderCard
              provider={provider}
              canEdit={canEdit}
              keyRequired={
                provider.presetId ? presetById.get(provider.presetId)?.keyRequired : false
              }
              defaultOpen={added?.id === provider.id}
            />
          </div>
        ))}
        {!custom.length && !adding && (
          <p className="text-sm text-muted-foreground">No custom model providers.</p>
        )}
      </section>
    </div>
  );
}
