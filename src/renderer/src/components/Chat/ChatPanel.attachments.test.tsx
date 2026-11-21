// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ATTACHMENTS_MAX, IMAGE_MAX_BYTES, type ChatMessage } from '@shared/ipc'
import { ChatPanel, type ChatPanelProps } from './ChatPanel'

afterEach(cleanup)

function setup(props: Partial<ChatPanelProps> = {}) {
  const send = vi.fn().mockResolvedValue(undefined)
  const all: ChatPanelProps = {
    hasProject: true,
    planReady: null,
    clearPlanReady: vi.fn(),
    pipelineStarted: null,
    messages: [],
    loading: false,
    busy: false,
    error: null,
    send,
    ...props
  }
  render(<ChatPanel {...all} />)
  return { send }
}

const png = (name = 'shot.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])], name, { type: 'image/png' })
const text = (name = 'notes.txt', body = 'hello') => new File([body], name, { type: 'text/plain' })
/** A file whose size is reported without allocating it. */
const sized = (name: string, type: string, size: number) => {
  const f = new File(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

const pick = (files: File[]) => fireEvent.change(screen.getByTestId('chat-file-input'), { target: { files } })

describe('ChatPanel attachments', () => {
  it('attaches picked files with a thumbnail for images, and sends them with the message', async () => {
    const { send } = setup()
    pick([png(), text()])
    const list = await screen.findByRole('list', { name: 'Attachments' })
    expect(within(list).getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/))
    expect(within(list).getByText('notes.txt')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'what is this?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledWith('what is this?', [
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', data: expect.any(String) },
      { kind: 'file', name: 'notes.txt', data: btoa('hello') }
    ])
    expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull()
  })

  it('can send attachments without text, and removes one before sending', async () => {
    const { send } = setup()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    pick([png('a.png'), png('b.png')])
    await screen.findByRole('img', { name: 'b.png' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledWith('', [expect.objectContaining({ name: 'b.png' })])
  })

  it('takes a pasted screenshot and names it', async () => {
    setup()
    const shot = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'image.png', { type: 'image/png' })
    fireEvent.paste(screen.getByLabelText('Message'), { clipboardData: { files: [shot], types: ['Files'] } })
    expect(await screen.findByRole('img', { name: 'pasted-image.png' })).toBeInTheDocument()
  })

  it('takes dropped files', async () => {
    setup()
    const form = screen.getByLabelText('Message').closest('form') as HTMLFormElement
    fireEvent.dragOver(form, { dataTransfer: { types: ['Files'], files: [] } })
    expect(form).toHaveClass('chat__form--drop')
    fireEvent.drop(form, { dataTransfer: { types: ['Files'], files: [text('drop.md')] } })
    expect(await screen.findByText('drop.md')).toBeInTheDocument()
    expect(form).not.toHaveClass('chat__form--drop')
  })

  it('refuses files over the limits and beyond the maximum count', async () => {
    setup()
    pick([sized('big.png', 'image/png', IMAGE_MAX_BYTES + 1)])
    expect(await screen.findByText(/big\.png is larger than/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull()
    pick(Array.from({ length: ATTACHMENTS_MAX + 2 }, (_, i) => text(`f${i}.txt`)))
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Attachments' })).getAllByRole('listitem')).toHaveLength(ATTACHMENTS_MAX))
    expect(screen.getByText(`Up to ${ATTACHMENTS_MAX} attachments per message.`)).toBeInTheDocument()
  })

  it('cannot attach while Claude is answering', () => {
    setup({ busy: true })
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled()
  })

  it('lists what was sent with a user message', () => {
    const sent: ChatMessage = {
      id: '1',
      role: 'user',
      text: '',
      at: '2026-01-01T00:00:00.000Z',
      attachments: [
        { kind: 'image', name: 'shot.png' },
        { kind: 'file', name: 'app.log', path: '.claude-desk/attachments/x-app.log' }
      ]
    }
    setup({ messages: [sent] })
    const list = screen.getByRole('list', { name: 'Sent attachments' })
    expect(list).toHaveTextContent('shot.png')
    expect(within(list).getByText('app.log').closest('li')).toHaveAttribute('title', '.claude-desk/attachments/x-app.log')
  })
})
