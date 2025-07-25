import { App, Notice, TFile } from "obsidian";
import moment, { Moment } from "moment-timezone";
import { AutoJournalSettings, BackFillOptions } from "./settings/settings";
import { APP_NAME, errorNotification } from "./utils/misc";
import { join, dirname, basename, fileNameNoExtension } from "./utils/path";
import { replaceNewFileVars } from "./utils/replace-new-file-vars";

/**
 * The core logic of the plugin
 * Creates daily and monthly notes based on the user's settings
 */
export default class Core {
	app: App;
	settings: AutoJournalSettings;
	dailyFileFormat: string;
	monthlyFileFormat: string;

	constructor(settings: AutoJournalSettings, app: App) {
		this.settings = settings;
		this.app = app;
	}

	async run() {
		this.dailyFileFormat = `${this.settings.yearFormat}/${this.settings.monthFormat}/${this.settings.dayFormat} - dddd`;
		this.monthlyFileFormat = `${this.settings.yearFormat}/[${this.settings.monthlyNotesFolderName}]/${this.settings.monthFormat} -`;

		if (this.settings.dailyNotesEnabled) {
			await this.createDailyNote().catch((error) => {
				errorNotification(
					error.message,
					this.settings.showDebugNotifications
				);
			});
		}

		if (this.settings.monthlyNotesEnabled) {
			await this.createMonthlyNote().catch((error) => {
				errorNotification(
					error.message,
					this.settings.showDebugNotifications
				);
			});
		}
	}

	async getNoteTemplateContents(
		type: "daily" | "monthly"
	): Promise<string | null> {
		const templatePath =
			type === "daily"
				? this.settings.dailyNotesTemplateFile
				: this.settings.monthlyNotesTemplateFile;
		let templateContents = "";
		if (templatePath) {
			const templateFile = this.app.vault.getAbstractFileByPath(
				`${templatePath}.md`
			);
			if (!templateFile) {
				new Notice(
					`${APP_NAME}: ${type} notes template file not found in ${templatePath}. Please update template file in the settings.`
				);
				return null;
			}
			if (templateFile instanceof TFile) {
				templateContents = await this.app.vault.read(templateFile);
			} else {
				new Notice(
					`${APP_NAME}: ${type} notes template file ${templatePath} is a directory, not a file. Please update template file in the settings.`
				);
				return null;
			}
		}
		return templateContents;
	}

	async createDailyNote() {
		const templateContents = await this.getNoteTemplateContents("daily");
		if (templateContents === null) {
			return;
		}

		const year = this.newDate().format(this.settings.yearFormat);

		for (let monthNumber = 0; monthNumber < 12; monthNumber++) {
			const dateOfMonth = this.newDate(year, monthNumber + 1, 1);
			const currentMonth = dateOfMonth
				.month(monthNumber)
				.format(this.settings.monthFormat);

			// Don't backfill for future months
			if (this.newDate().get("month") < monthNumber) {
				continue;
			}

			if (
				this.settings.dailyNotesBackfill === BackFillOptions.MONTH ||
				this.settings.dailyNotesBackfill === BackFillOptions.NONE
			) {
				if (
					currentMonth !==
					this.newDate().format(this.settings.monthFormat)
				) {
					continue;
				}
			}

			const dayOfMonthFilePath =
				dateOfMonth.format(this.dailyFileFormat) + ".md";
			const monthsFolderPath = dirname(dayOfMonthFilePath);
			// Get all the files in the month folder
			const filesInFolder = this.app.vault.getFiles().filter((file) => {
				let folderPath = join(
					this.settings.rootFolder,
					monthsFolderPath
				);
				if (folderPath.startsWith("/")) {
					folderPath = folderPath.slice(1);
				}
				return file.path.startsWith(folderPath);
			});

			const daysInMonth = dateOfMonth.daysInMonth();
			// Make sure there is an entry for each day of the month
			for (let day = 1; day <= daysInMonth; day++) {
				const dayDate = this.newDate(year, monthNumber + 1, day);

				// If we are in the current month, only add entires up to today
				if (
					currentMonth ===
					this.newDate().format(this.settings.monthFormat)
				) {
					if (dayDate.date() > this.newDate().date()) {
						continue;
					}
				}

				// Check if file exists for month
				let hasFileForDay = false;
				for (const file of filesInFolder) {
					const fileDayPart = file.basename.split("-")[0].trim();
					if (
						fileDayPart === dayDate.format(this.settings.dayFormat)
					) {
						hasFileForDay = true;
					}
				}
				if (hasFileForDay) {
					continue;
				}

				// If backfill is set to NONE, don't create for days before today
				if (
					this.settings.dailyNotesBackfill === BackFillOptions.NONE &&
					dayDate.date() < this.newDate().date()
				) {
					continue;
				}

				// When the note is for the current day, and the "use today for latest note" setting is enabled
				// Set the date to today, a minute in the future to support notifications via Reminder plugin
				let createFileDate = dayDate;
				if (
					this.settings.useTodayForLatestNote &&
					this.newDate().format("YYYY-MM-DD") ===
						dayDate.format("YYYY-MM-DD")
				) {
					createFileDate = this.newDate().add(1, "minute");
				}

				// Create the file for the day
				const newFilePath = dayDate.format(this.dailyFileFormat);
				await this.createNewFile(
					createFileDate,
					newFilePath,
					templateContents,
					filesInFolder
				).catch((error) => {
					errorNotification(
						error.message,
						this.settings.showDebugNotifications
					);
				});
			}
		}
	}

	async createMonthlyNote() {
		const templateContents = await this.getNoteTemplateContents("monthly");
		if (templateContents === null) {
			return;
		}

		const year = this.newDate().format(this.settings.yearFormat);

		const dayOfMonthFilePath =
			this.newDate().format(this.monthlyFileFormat) + ".md";
		const monthlyNotesFolderPath = dirname(dayOfMonthFilePath);

		// Get all the files in the month folder
		const filesInFolder = this.app.vault.getFiles().filter((file) => {
			let folderPath = join(
				this.settings.rootFolder,
				monthlyNotesFolderPath
			);
			if (folderPath.startsWith("/")) {
				folderPath = folderPath.slice(1);
			}

			return (
				file.path.startsWith(folderPath) &&
				(file?.parent?.name
					? file.parent.name === this.settings.monthlyNotesFolderName
					: true)
			);
		});

		for (let monthNumber = 0; monthNumber < 12; monthNumber++) {
			const monthDate = this.newDate(
				year,
				monthNumber + 1,
				this.settings.monthlyNotesDayOfMonth
			);

			// Don't backfill for future months
			if (this.newDate().get("month") < monthNumber) {
				continue;
			}

			// Only backfill for the current month if the backfill setting isn't set to YEAR
			if (this.settings.monthlyNotesBackfill !== BackFillOptions.YEAR) {
				if (
					monthDate.format(this.settings.monthFormat) !==
					this.newDate().format(this.settings.monthFormat)
				) {
					continue;
				}
			}

			let hasFileForMonth = false;
			for (const file of filesInFolder) {
				const fileMonthPart = file.basename.split("-")[0].trim();
				if (
					fileMonthPart ===
					monthDate.format(this.settings.monthFormat)
				) {
					hasFileForMonth = true;
				}
			}
			if (hasFileForMonth) {
				continue;
			}

			// Don't create for day of month if before this.settings.monthlyNotesDayOfMonth
			if (
				this.newDate().date() < this.settings.monthlyNotesDayOfMonth &&
				monthNumber === this.newDate().month()
			) {
				continue;
			}

			// When the note is for the current month, and the "use today for latest note" setting is enabled
			// Set the date to today, a minute in the future to support notifications via Reminder plugin
			let createFileDate = monthDate;
			if (
				this.settings.useTodayForLatestNote &&
				this.newDate().month() === monthDate.month() &&
				this.newDate().year() === monthDate.year()
			) {
				createFileDate = this.newDate().add(1, "minute");
			}

			// Create the file for the day
			const newFilePath = monthDate.format(this.monthlyFileFormat);
			await this.createNewFile(
				createFileDate,
				newFilePath,
				templateContents,
				filesInFolder
			).catch((error) => {
				errorNotification(
					error.message,
					this.settings.showDebugNotifications
				);
			});
		}
	}

	async createNewFile(
		createdDate: Moment,
		newFilePath: string,
		templateContents: string,
		filesInFolder: TFile[]
	): Promise<string> {
		if (!newFilePath.endsWith(".md")) {
			newFilePath += ".md";
		}
		if (!newFilePath.startsWith(this.settings.rootFolder)) {
			newFilePath = join(this.settings.rootFolder, newFilePath);
		}
		let folderPath = dirname(newFilePath);

		if (folderPath.startsWith("/")) {
			folderPath = folderPath.slice(1);
		}

		// Check if the folder exists, if not, create it
		if (!this.app.vault.getAbstractFileByPath(folderPath)) {
			let prevPath = "";
			for (const folderName of folderPath.split("/")) {
				const cascadePath = join(prevPath, folderName);
				if (!this.app.vault.getAbstractFileByPath(cascadePath)) {
					try {
						await this.app.vault.createFolder(cascadePath);
					} catch (error) {
						errorNotification(
							`Error creating folder, ${cascadePath} for ${newFilePath}`,
							this.settings.showDebugNotifications
						);
					}
				}
				prevPath = cascadePath;
			}
		}

		// Check if the file exists for day, if not, create it
		const dayPart = basename(newFilePath).split("-")[0].trim();
		let existingFile = undefined;
		for (const file of filesInFolder) {
			const existingDayPart = file.basename.split("-")[0].trim();
			if (existingDayPart === dayPart) {
				existingFile = file;
				break;
			}
		}

		// Important that we run this before replaceNewFileVars
		if (
			this.settings.shouldTemplateDate &&
			templateContents.includes(this.settings.templateDateToken)
		) {
			templateContents = templateContents.replace(
				this.settings.templateDateToken,
				createdDate.format(`${this.settings.templateDateFormat}`)
			);
		}

		templateContents = await replaceNewFileVars(
			this.app,
			templateContents,
			fileNameNoExtension(newFilePath)
		);

		if (!existingFile) {
			await this.app.vault.create(newFilePath, templateContents);
		}

		return newFilePath;
	}

	/**
	 *
	 * @param year - The year as a string e.g. "2021"
	 * @param month - The month as a string e.g. "1"
	 * @param day - The day as a string e.g. "1"
	 * @returns A string in the format "YYYY-MM-DD"
	 */
	newDate(
		year?: string | number,
		month?: string | number,
		day?: string | number
	) {
		const timezone = this.settings.timezone || moment.tz.guess();
		if (!year || !month || !day) {
			return moment().tz(timezone);
		}
		return moment(
			`${year.toString()}-${month.toString().padStart(2, "0")}-${day
				.toString()
				.padStart(2, "0")}`,
			"YYYY-MM-DD"
		).tz(timezone);
	}
}
