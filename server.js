const express = require("express")
const cors = require("cors")
const crypto = require("crypto")

const app = express()

const PORT = process.env.PORT || 10000
const HOST = "0.0.0.0"

const PRINT_API_KEY = process.env.PRINT_API_KEY || ""

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Print-Api-Key"],
  })
)

app.use(express.json({ limit: "2mb" }))

// =====================================================
// IN-MEMORY PRINT JOB STORAGE
// =====================================================
//
// NOTE:
// Render Free instances can restart.
// This storage is okay for testing/simple usage.
// For permanent production queue, use PostgreSQL/Redis later.
//

const printJobs = new Map()

// =====================================================
// AUTH
// =====================================================

function checkApiKey(req, res, next) {
  if (!PRINT_API_KEY) {
    return next()
  }

  const apiKey =
    req.headers["x-print-api-key"] ||
    req.headers.authorization?.replace("Bearer ", "")

  if (apiKey !== PRINT_API_KEY) {
    return res.status(401).json({
      success: false,
      message: "Invalid print API key.",
    })
  }

  next()
}

// =====================================================
// HELPERS
// =====================================================

function createJobId() {
  return `print_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
}

function cleanOldJobs() {
  const now = Date.now()

  for (const [id, job] of printJobs.entries()) {
    const created = new Date(job.created_at).getTime()

    // Remove completed/failed jobs older than 1 hour
    if (
      ["completed", "failed"].includes(job.status) &&
      now - created > 60 * 60 * 1000
    ) {
      printJobs.delete(id)
    }
  }
}

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "ELKJ IT Solutions Print API",
    status: "online",
    environment: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
  })
})

// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    jobs: printJobs.size,
    time: new Date().toISOString(),
  })
})

// =====================================================
// CREATE PRINT JOB
// =====================================================

app.post("/print-job", checkApiKey, (req, res) => {
  try {
    const { sale, printer_name } = req.body

    if (!sale) {
      return res.status(422).json({
        success: false,
        message: "sale is required.",
      })
    }

    const jobId = createJobId()

    const job = {
      id: jobId,
      status: "pending",

      printer_name: printer_name || null,

      sale,

      attempts: 0,

      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),

      processing_at: null,
      completed_at: null,
      failed_at: null,

      error: null,
    }

    printJobs.set(jobId, job)

    return res.status(201).json({
      success: true,
      message: "Print job created.",
      job,
    })
  } catch (error) {
    console.error("Create print job error:", error)

    return res.status(500).json({
      success: false,
      message: "Failed to create print job.",
    })
  }
})

// =====================================================
// GET PENDING JOB
// =====================================================

app.get("/print-job/next", checkApiKey, (req, res) => {
  try {
    cleanOldJobs()

    const pendingJob = [...printJobs.values()]
      .filter((job) => job.status === "pending")
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() -
          new Date(b.created_at).getTime()
      )[0]

    if (!pendingJob) {
      return res.json({
        success: true,
        job: null,
      })
    }

    // Lock job
    pendingJob.status = "processing"
    pendingJob.attempts += 1
    pendingJob.processing_at = new Date().toISOString()
    pendingJob.updated_at = new Date().toISOString()

    printJobs.set(pendingJob.id, pendingJob)

    return res.json({
      success: true,
      job: pendingJob,
    })
  } catch (error) {
    console.error("Get next job error:", error)

    return res.status(500).json({
      success: false,
      message: "Failed to get print job.",
    })
  }
})

// =====================================================
// GET JOB BY ID
// =====================================================

app.get("/print-job/:id", checkApiKey, (req, res) => {
  const job = printJobs.get(req.params.id)

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Print job not found.",
    })
  }

  return res.json({
    success: true,
    job,
  })
})

// =====================================================
// COMPLETE JOB
// =====================================================

app.post("/print-job/:id/complete", checkApiKey, (req, res) => {
  const job = printJobs.get(req.params.id)

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Print job not found.",
    })
  }

  job.status = "completed"
  job.completed_at = new Date().toISOString()
  job.updated_at = new Date().toISOString()
  job.error = null

  printJobs.set(job.id, job)

  return res.json({
    success: true,
    message: "Print job completed.",
    job,
  })
})

// =====================================================
// FAIL JOB
// =====================================================

app.post("/print-job/:id/fail", checkApiKey, (req, res) => {
  const job = printJobs.get(req.params.id)

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Print job not found.",
    })
  }

  const errorMessage =
    req.body?.error || "Unknown printing error."

  job.status = "failed"
  job.failed_at = new Date().toISOString()
  job.updated_at = new Date().toISOString()
  job.error = errorMessage

  printJobs.set(job.id, job)

  return res.json({
    success: true,
    message: "Print job marked as failed.",
    job,
  })
})

// =====================================================
// RETRY JOB
// =====================================================

app.post("/print-job/:id/retry", checkApiKey, (req, res) => {
  const job = printJobs.get(req.params.id)

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Print job not found.",
    })
  }

  job.status = "pending"
  job.error = null
  job.processing_at = null
  job.failed_at = null
  job.updated_at = new Date().toISOString()

  printJobs.set(job.id, job)

  return res.json({
    success: true,
    message: "Print job queued again.",
    job,
  })
})

// =====================================================
// LIST JOBS
// =====================================================

app.get("/print-jobs", checkApiKey, (req, res) => {
  cleanOldJobs()

  const jobs = [...printJobs.values()]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() -
        new Date(a.created_at).getTime()
    )
    .slice(0, 100)

  return res.json({
    success: true,
    jobs,
  })
})

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, HOST, () => {
  console.log("==========================================")
  console.log("ELKJ IT Solutions Print API")
  console.log("==========================================")
  console.log(`Host: ${HOST}`)
  console.log(`Port: ${PORT}`)
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`)
  console.log("==========================================")
})
