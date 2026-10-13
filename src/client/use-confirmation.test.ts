import { reactive } from 'vue';
import { describe, expect, it } from 'vitest';
import { useConfirmation } from './use-confirmation';

const options = { title: 'Create branch', summary: 'Track remote', details: [], confirmLabel: 'Create' };

describe('confirmation input', () => {
  it('keeps the dialog open for invalid input and returns the edited value to its caller', async () => {
    const { confirmation, requestConfirmation, settleConfirmation } = useConfirmation();
    const input = reactive({ label: 'Branch', value: 'taken', validate: (value: string) => value === 'taken' ? 'Already exists' : null });
    const pending = requestConfirmation({ ...options, input });
    settleConfirmation(true);
    expect(confirmation.value).not.toBeNull();
    confirmation.value!.input!.value = '  ';
    settleConfirmation(true);
    expect(confirmation.value).not.toBeNull();
    confirmation.value!.input!.value = '  feature/local  ';
    settleConfirmation(true);
    expect(await pending).toBe(true);
    expect(input.value.trim()).toBe('feature/local');
    expect(confirmation.value).toBeNull();
  });

  it('can cancel invalid input and settles replaced requests without accepting them', async () => {
    const { confirmation, requestConfirmation, settleConfirmation } = useConfirmation();
    const canceled = requestConfirmation({ ...options, input: { label: 'Branch', value: '' } });
    settleConfirmation(false);
    expect(await canceled).toBe(false);
    const replaced = requestConfirmation({ ...options, input: { label: 'Branch', value: 'old' } });
    const replacement = requestConfirmation(options);
    expect(await replaced).toBe(false);
    expect(confirmation.value?.input).toBeUndefined();
    settleConfirmation(true);
    expect(await replacement).toBe(true);
  });
});
