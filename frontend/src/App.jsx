import { useEffect, useMemo, useState } from 'react'
import './App.css'

const API_BASE = 'http://localhost:8000'
const WS_URL = 'ws://localhost:8000/ws'

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

function App() {
  const [stories, setStories] = useState([])
  const [showForm, setShowForm] = useState(false)
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
    socket.onmessage = () => {
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
    const payload = new FormData()
    payload.append('reaction_type', reactionType)
    await fetch(`${API_BASE}/stories/${storyId}/react`, {
      method: 'POST',
      body: payload,
    })
  }

  const getStoryImage = (story) => {
    if (story.image_upload_url) {
      return `${API_BASE}${story.image_upload_url}`
    }
    return story.image_url || null
  }

  return (
    <div className="page">
      <header className="newspaper-header">
        <p className="edition">Local Edition</p>
        <h1>The Daily Neighborhood</h1>
        <p className="tagline">A live community front page</p>
      </header>

      {errorMessage ? <p className="error-message">{errorMessage}</p> : null}

      <main className="newspaper-grid">
        {slots.map((slot, index) => (
          <article key={slot.label} className={`slot slot-${slot.type}`}>
            <p className="slot-label">{slot.label}</p>
            {slot.story ? (
              <>
                <h2>{slot.story.headline}</h2>
                <p className="story-meta">
                  By {slot.story.author_name} • {new Date(slot.story.created_at).toLocaleString()}
                </p>
                {getStoryImage(slot.story) ? (
                  <img
                    className="story-image"
                    src={getStoryImage(slot.story)}
                    alt={slot.story.headline}
                  />
                ) : null}
                <p>{index < 7 ? slot.story.main_story : slot.story.summary_sentence}</p>
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
              </>
            ) : (
              <p className="placeholder-text">Waiting for the next story...</p>
            )}
          </article>
        ))}
      </main>

      <button className="add-story-button" type="button" onClick={() => setShowForm(true)}>
        +
      </button>

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
