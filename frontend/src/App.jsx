import { useEffect, useMemo, useState } from 'react'
import './App.css'

/**
 * Dev: talk to local FastAPI.
 * Prod: set VITE_API_BASE in .env.production (e.g. https://yourdomain.com), or leave unset to use
 * same-origin URLs (/stories/visible, /ws, …) when Caddy proxies those paths to FastAPI.
 */
function apiBase() {
  if (import.meta.env.DEV) {
    return 'http://localhost:8000'
  }
  const fromEnv = import.meta.env.VITE_API_BASE
  if (fromEnv) {
    return String(fromEnv).replace(/\/$/, '')
  }
  return ''
}

function wsUrl() {
  if (import.meta.env.DEV) {
    return 'ws://localhost:8000/ws'
  }
  const explicit = import.meta.env.VITE_WS_URL
  if (explicit) {
    return String(explicit)
  }
  const base = import.meta.env.VITE_API_BASE
  if (base) {
    const url = new URL(String(base))
    const proto = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${url.host}/ws`
  }
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/ws`
  }
  return 'ws://localhost:8000/ws'
}

const API_BASE = apiBase()
const WS_URL = wsUrl()
const BOOKCLUB_URL = import.meta.env.DEV ? 'http://localhost:5173' : '/bookclub/'

const SLOT_LABELS = [
  'Hero',
  'Secondary 1',
  'Secondary 2',
  'Secondary 3',
  'Secondary 4',
  'Secondary 5',
  'Secondary 6',
  'Brief 1',
  'Brief 2',
  'Brief 3',
  'Brief 4',
  'Brief 5',
  'Brief 6',
  'Brief 7',
  'Brief 8',
]

const REACTION_TYPES = [
  { id: 'like', label: 'Like', emoji: '👍' },
  { id: 'love', label: 'Love', emoji: '❤️' },
  { id: 'wow', label: 'Wow', emoji: '😮' },
  { id: 'laugh', label: 'Laugh', emoji: '😂' },
]

const SLOT_AREA_CLASSES = [
  'lead-main',
  'lead-left',
  'side-1',
  'side-2',
  'banner',
  'mid-1',
  'mid-2',
  'brief-1',
  'brief-2',
  'brief-3',
  'brief-4',
  'brief-5',
  'brief-6',
  'brief-7',
  'brief-8',
]

function App() {
  const [stories, setStories] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [expandedBriefId, setExpandedBriefId] = useState(null)
  const [showMenu, setShowMenu] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [formData, setFormData] = useState({
    author_name: '',
    headline: '',
    summary_sentence: '',
    main_story: '',
    image_url: '',
    image_upload: null,
  })

  const slots = useMemo(() => {
    return SLOT_LABELS.map((label, index) => ({
      label,
      story: stories[index] ?? null,
      type: index === 0 ? 'hero' : index <= 6 ? 'secondary' : 'brief',
    }))
  }, [stories])

  const expandedBriefStory =
    expandedBriefId != null ? stories.find((s) => s.id === expandedBriefId) ?? null : null

  useEffect(() => {
    if (expandedBriefId != null && !stories.some((s) => s.id === expandedBriefId)) {
      setExpandedBriefId(null)
    }
  }, [stories, expandedBriefId])

  useEffect(() => {
    if (expandedBriefId == null) return undefined
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setExpandedBriefId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expandedBriefId])

  const fetchVisibleStories = async () => {
    const response = await fetch(`${API_BASE}/stories/visible`)
    if (!response.ok) {
      throw new Error('Unable to load stories.')
    }
    const payload = await response.json()
    setStories(payload.stories ?? [])
  }

  useEffect(() => {
    fetchVisibleStories().catch(() => {
      setErrorMessage('Could not load stories from the server.')
    })
  }, [])

  useEffect(() => {
    const socket = new WebSocket(WS_URL)
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'reaction_updated' && data.story_id != null && data.reaction_type != null) {
          setStories((prev) =>
            prev.map((s) =>
              s.id === data.story_id
                ? {
                    ...s,
                    reactions: {
                      ...s.reactions,
                      [data.reaction_type]: data.count,
                    },
                  }
                : s
            )
          )
          return
        }
      } catch {
        // fall through to full refresh
      }
      fetchVisibleStories().catch(() => {
        setErrorMessage('Live update failed. Trying again soon.')
      })
    }
    return () => {
      socket.close()
    }
  }, [])

  const handleInputChange = (event) => {
    const { name, value, files } = event.target
    if (name === 'image_upload') {
      setFormData((prev) => ({ ...prev, image_upload: files?.[0] ?? null }))
      return
    }
    setFormData((prev) => ({ ...prev, [name]: value }))
  }

  const resetForm = () => {
    setFormData({
      author_name: '',
      headline: '',
      summary_sentence: '',
      main_story: '',
      image_url: '',
      image_upload: null,
    })
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setIsSubmitting(true)
    setErrorMessage('')
    try {
      const payload = new FormData()
      payload.append('author_name', formData.author_name)
      payload.append('headline', formData.headline)
      payload.append('summary_sentence', formData.summary_sentence)
      payload.append('main_story', formData.main_story)
      payload.append('image_url', formData.image_url)
      if (formData.image_upload) {
        payload.append('image_upload', formData.image_upload)
      }

      const response = await fetch(`${API_BASE}/stories/add`, {
        method: 'POST',
        body: payload,
      })
      if (!response.ok) {
        const payloadError = await response.json()
        throw new Error(payloadError.detail ?? 'Unable to publish story.')
      }

      resetForm()
      setShowForm(false)
      await fetchVisibleStories()
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const reactToStory = async (storyId, reactionType) => {
    setStories((prev) =>
      prev.map((s) =>
        s.id === storyId
          ? {
              ...s,
              reactions: {
                ...s.reactions,
                [reactionType]: (s.reactions?.[reactionType] ?? 0) + 1,
              },
            }
          : s
      )
    )
    try {
      const payload = new FormData()
      payload.append('reaction_type', reactionType)
      const response = await fetch(`${API_BASE}/stories/${storyId}/react`, {
        method: 'POST',
        body: payload,
      })
      if (!response.ok) {
        await fetchVisibleStories()
        return
      }
      const data = await response.json()
      setStories((prev) =>
        prev.map((s) =>
          s.id === data.story_id
            ? {
                ...s,
                reactions: {
                  ...s.reactions,
                  [data.reaction_type]: data.count,
                },
              }
            : s
        )
      )
    } catch {
      await fetchVisibleStories()
    }
  }

  const getStoryImage = (story) => {
    if (story.image_upload_url) {
      return `${API_BASE}${story.image_upload_url}`
    }
    return story.image_url || null
  }

  const renderStoryBody = (story, index) => {
    const image = getStoryImage(story)
    const prefersLeftWrap = index % 2 === 0
    const isHero = index === 0
    const isSecondary = index > 0 && index < 7

    if (index >= 7) {
      return (
        <>
          {image ? (
            <img
              className="story-image story-image-brief"
              src={image}
              alt={story.headline}
            />
          ) : null}
          <p className="brief-summary">{story.summary_sentence}</p>
          <button
            type="button"
            className="brief-expand-btn"
            onClick={() => setExpandedBriefId(story.id)}
          >
            Expand full story
          </button>
        </>
      )
    }

    return (
      <div className="story-flow">
        {image ? (
          <figure
            className={`story-image-wrap ${prefersLeftWrap ? 'left' : 'right'} ${isSecondary ? 'secondary' : ''} ${isHero ? 'hero' : ''}`}
          >
            <img className="story-image story-image-inline" src={image} alt={story.headline} />
          </figure>
        ) : null}
        <p className={`story-copy ${isHero ? 'hero-copy' : ''} ${isSecondary ? 'secondary-copy' : ''}`}>
          {story.main_story}
        </p>
      </div>
    )
  }

  return (
    <div className="page">
      <button
        className="menu-button"
        type="button"
        aria-label="Open navigation menu"
        onClick={() => setShowMenu((prev) => !prev)}
      >
        <span />
        <span />
        <span />
      </button>

      {showMenu ? (
        <div className="menu-backdrop" onClick={() => setShowMenu(false)}>
          <nav className="menu-panel" onClick={(event) => event.stopPropagation()}>
            <p className="menu-title">Navigate</p>
            <a href="/" onClick={() => setShowMenu(false)}>
              Front Page
            </a>
            <a href={BOOKCLUB_URL} onClick={() => setShowMenu(false)}>
              BookClub Eliminator
            </a>
          </nav>
        </div>
      ) : null}

      <header className="newspaper-header">
        <div className="masthead-topline">
          <p className="edition">Local Edition</p>
          <p className="tagline">A live community front page</p>
        </div>
        <h1>The Artisonian</h1>
        <p className="masthead-subtitle">Daily Neighborhood News</p>
        <div className="masthead-rule" />
      </header>

      {errorMessage ? <p className="error-message">{errorMessage}</p> : null}

      <main className="newspaper-grid">
        {slots.map((slot, index) => (
          <article
            key={slot.label}
            className={`slot slot-${slot.type} area-${SLOT_AREA_CLASSES[index]}`}
          >
            <p className="slot-label">{slot.label}</p>
            {slot.story ? (
              <div className="slot-inner">
                <h2>{slot.story.headline}</h2>
                <p className="story-meta">
                  By {slot.story.author_name} • {new Date(slot.story.created_at).toLocaleString()}
                </p>
                {renderStoryBody(slot.story, index)}
                <div className="reactions">
                  {REACTION_TYPES.map((reaction) => (
                    <button
                      key={reaction.id}
                      type="button"
                      onClick={() => reactToStory(slot.story.id, reaction.id)}
                    >
                      <span>{reaction.emoji}</span>
                      <span>{slot.story.reactions?.[reaction.id] ?? 0}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="slot-inner slot-inner--empty">
                <p className="placeholder-text">Waiting for the next story...</p>
              </div>
            )}
          </article>
        ))}
      </main>

      <button className="add-story-button" type="button" onClick={() => setShowForm(true)}>
        +
      </button>

      {expandedBriefStory ? (
        <div
          className="modal-backdrop read-modal-backdrop"
          onClick={() => setExpandedBriefId(null)}
          role="presentation"
        >
          <article
            className="read-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="read-modal-title"
          >
            <button
              type="button"
              className="read-modal-close"
              onClick={() => setExpandedBriefId(null)}
              aria-label="Close"
            >
              ×
            </button>
            <h2 id="read-modal-title" className="read-modal-headline">
              {expandedBriefStory.headline}
            </h2>
            <p className="story-meta read-modal-meta">
              By {expandedBriefStory.author_name} •{' '}
              {new Date(expandedBriefStory.created_at).toLocaleString()}
            </p>
            {getStoryImage(expandedBriefStory) ? (
              <img
                className="read-modal-image"
                src={getStoryImage(expandedBriefStory)}
                alt={expandedBriefStory.headline}
              />
            ) : null}
            <div className="read-modal-body">{expandedBriefStory.main_story}</div>
          </article>
        </div>
      ) : null}

      {showForm ? (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <section className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>Submit Story</h3>
            <form onSubmit={handleSubmit}>
              <label>
                Your Name
                <input name="author_name" value={formData.author_name} onChange={handleInputChange} required />
              </label>
              <label>
                Headline
                <input name="headline" value={formData.headline} onChange={handleInputChange} required />
              </label>
              <label>
                One-Sentence Summary
                <input
                  name="summary_sentence"
                  value={formData.summary_sentence}
                  onChange={handleInputChange}
                  required
                />
              </label>
              <label>
                Main Story
                <textarea name="main_story" value={formData.main_story} onChange={handleInputChange} required />
              </label>
              <label>
                Image URL (optional)
                <input name="image_url" value={formData.image_url} onChange={handleInputChange} />
              </label>
              <label>
                Upload Image (optional)
                <input name="image_upload" type="file" accept="image/*" onChange={handleInputChange} />
              </label>
              <div className="form-actions">
                <button type="button" className="ghost" onClick={() => setShowForm(false)}>
                  Cancel
                </button>
                <button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Publishing...' : 'Publish'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  )
}

export default App
