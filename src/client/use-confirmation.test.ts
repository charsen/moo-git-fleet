import { reactive } from 'vue';
import { describe, expect, it } from 'vitest';
import { confirmationBlocked, useConfirmation } from './use-confirmation';

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

describe('confirmation checkboxes', () => {
  it('keeps the dialog open until every required checkbox is ticked, and returns the edited values', async () => {
    const { confirmation, requestConfirmation, settleConfirmation } = useConfirmation();
    const force = { id: 'force', label: 'Force delete', required: true, value: false };
    const backup = { id: 'backup', label: 'Backup as tag', value: true };
    const pending = requestConfirmation({ ...options, checkboxes: [force, backup] });

    expect(confirmationBlocked({ checkboxes: [force, backup] })).toBe(true);
    settleConfirmation(true);
    expect(confirmation.value).not.toBeNull();

    force.value = true;
    expect(confirmationBlocked({ checkboxes: [force, backup] })).toBe(false);
    backup.value = false;
    settleConfirmation(true);
    expect(await pending).toBe(true);
    // 调用方持有的是同一份对象，因此能读到勾选后的值。
    expect(force.value).toBe(true);
    expect(backup.value).toBe(false);
    expect(confirmation.value).toBeNull();
  });

  it('blocks on an invalid input even when the required checkbox is ticked', () => {
    expect(confirmationBlocked({
      input: { label: 'Name', value: '' },
      checkboxes: [{ id: 'force', label: 'Force', required: true, value: true }],
    })).toBe(true);
  });
});
