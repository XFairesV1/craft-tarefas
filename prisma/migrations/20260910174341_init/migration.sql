-- CreateTable
CREATE TABLE "Config" (
    "id" SERIAL NOT NULL,
    "playerName" TEXT NOT NULL DEFAULT 'Steve',
    "pointsPerReal" INTEGER NOT NULL DEFAULT 100,
    "redeemedPoints" INTEGER NOT NULL DEFAULT 0,
    "passwordHash" TEXT NOT NULL,
    "achievements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "desc" TEXT NOT NULL DEFAULT '',
    "points" INTEGER NOT NULL,
    "frequencyPerWeek" INTEGER NOT NULL DEFAULT 7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" SERIAL NOT NULL,
    "taskId" INTEGER NOT NULL,
    "taskName" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "photo" BYTEA NOT NULL,
    "photoMime" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Submission_taskId_status_createdAt_idx" ON "Submission"("taskId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
